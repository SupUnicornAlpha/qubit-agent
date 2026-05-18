import { randomUUID } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  a2aMessage,
  agentDefinition,
  agentInstance,
  alertEvent,
  brokerOrder,
  communicationMessageLog,
  executionTask,
  orderIntent,
  scheduledJob,
  scheduledJobRun,
  workflowRun,
} from "../../db/sqlite/schema";
import { processExecutionTasks } from "../execution/execution-worker";
import { createOrderIntentFromReiaPayload } from "../execution/reia-bridge";
import { brokerCancelOrder } from "../reia/broker-service";
import { queryMarketNewsBrief } from "../market/news-brief-query";
import { listStrategyRuntimeLogs } from "../strategy/strategy-runtime-log";
import { listStrategyRuntimes } from "../strategy/strategy-runtime-service";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";

export interface TraderSessionContext {
  workflowRunId: string;
  projectId: string;
  sessionId: string;
}

const TRADER_WORKFLOW_GOAL = "QUBIT 实时交易 Agent 执行上下文";

export async function ensureTraderSession(input: {
  projectId: string;
  sessionId: string;
}): Promise<TraderSessionContext> {
  const db = await getDb();
  const existing = await db
    .select()
    .from(workflowRun)
    .where(
      and(
        eq(workflowRun.projectId, input.projectId),
        eq(workflowRun.sessionId, input.sessionId),
        eq(workflowRun.goal, TRADER_WORKFLOW_GOAL)
      )
    )
    .orderBy(desc(workflowRun.startedAt))
    .limit(1);

  if (existing[0]) {
    return {
      workflowRunId: existing[0].id,
      projectId: input.projectId,
      sessionId: input.sessionId,
    };
  }

  const created = await createAndDispatchWorkflow({
    projectId: input.projectId,
    goal: TRADER_WORKFLOW_GOAL,
    mode: "simulation",
    sessionId: input.sessionId,
    source: "api",
    skipDispatch: true,
    reuseSessionWorkflow: false,
  });
  return {
    workflowRunId: created.data.id,
    projectId: input.projectId,
    sessionId: input.sessionId,
  };
}

function chartExchangeToMarket(exchange: string): string {
  const u = exchange.trim().toUpperCase();
  if (u === "HK") return "HK";
  if (u === "US") return "US";
  if (u === "CRYPTO") return "CRYPTO";
  return "CN";
}

export async function placeTraderOrder(input: {
  workflowRunId: string;
  symbol: string;
  exchange: string;
  side: "buy" | "sell";
  qty: number;
  price?: number | null;
  orderType?: "market" | "limit";
  timeframe?: string;
  rationale?: string;
  executionMode?: "paper" | "live";
  strategyRuntimeId?: string;
  signalBarTime?: string;
}): Promise<{
  orderIntentId: string;
  executionTaskId: string | null;
  legacyIntentOrderId?: string;
  riskOutcome: string;
  riskReason: string;
}> {
  const sym = input.symbol.trim().toUpperCase();
  if (!sym) throw new Error("symbol is required");
  const qty = Math.max(1, Math.floor(input.qty));
  const market = chartExchangeToMarket(input.exchange);
  const direction = input.side === "sell" ? "short" : "long";
  const targetPrice =
    input.price != null && Number.isFinite(input.price) && input.price > 0
      ? Number(input.price)
      : input.orderType === "market"
        ? 0
        : 1;

  if (targetPrice <= 0 && input.orderType !== "market") {
    throw new Error("limit order requires price > 0");
  }

  const db = await getDb();
  const result = await createOrderIntentFromReiaPayload(
    {
      workflowRunId: input.workflowRunId,
      ticker: sym,
      direction,
      quantity: qty,
      targetPrice: targetPrice > 0 ? targetPrice : 100,
      rationale: input.rationale ?? `trader_ui:${input.side}`,
      market,
      timeframe: input.timeframe,
      executionMode: input.executionMode ?? "paper",
      strategyRuntimeId: input.strategyRuntimeId,
      signalBarTime: input.signalBarTime,
    },
    db
  );

  await processExecutionTasks(db);

  return {
    orderIntentId: result.orderIntentId,
    executionTaskId: result.executionTaskId,
    legacyIntentOrderId: result.legacyIntentOrderId,
    riskOutcome: result.riskOutcome,
    riskReason: result.riskReason,
  };
}

export async function cancelTraderOrder(input: {
  orderIntentId?: string;
  brokerOrderId?: string;
  provider?: "futu" | "ib" | "ccxt";
}): Promise<{ cancelled: boolean; detail: string }> {
  const db = await getDb();

  if (input.brokerOrderId) {
    await brokerCancelOrder({
      provider: input.provider ?? "futu",
      brokerOrderId: input.brokerOrderId,
    });
    return { cancelled: true, detail: `broker_order ${input.brokerOrderId}` };
  }

  if (!input.orderIntentId) throw new Error("orderIntentId or brokerOrderId is required");

  const tasks = await db
    .select()
    .from(executionTask)
    .where(eq(executionTask.orderIntentId, input.orderIntentId))
    .limit(1);
  const task = tasks[0];
  if (!task) {
    return { cancelled: false, detail: "execution_task_not_found" };
  }

  const orders = await db
    .select()
    .from(brokerOrder)
    .where(eq(brokerOrder.orderIntentId, input.orderIntentId))
    .orderBy(desc(brokerOrder.createdAt))
    .limit(1);
  const bo = orders[0];
  if (!bo?.brokerOrderId) {
    await db
      .update(executionTask)
      .set({ status: "cancelled", updatedAt: new Date().toISOString() })
      .where(eq(executionTask.id, task.id));
    return { cancelled: true, detail: "task_cancelled_before_broker_submit" };
  }

  if (bo.status === "filled" || bo.status === "cancelled") {
    return { cancelled: false, detail: `broker_order_status=${bo.status}` };
  }

  await brokerCancelOrder({
    provider: input.provider ?? "futu",
    brokerOrderId: bo.brokerOrderId,
  });
  await db
    .update(brokerOrder)
    .set({ status: "cancelled", updatedAt: new Date().toISOString() })
    .where(eq(brokerOrder.id, bo.id));
  return { cancelled: true, detail: `broker_order ${bo.brokerOrderId}` };
}

export type TraderDriverKind =
  | "scheduled_job"
  | "strategy_runtime"
  | "news"
  | "communication"
  | "alert"
  | "user_command"
  | "interval_poll";

export type TraderDriverEvent = {
  type: "driver";
  id: string;
  ts: string;
  driverKind: TraderDriverKind;
  title: string;
  detail: string;
  payload?: Record<string, unknown>;
};

export type TraderAgentMessageEvent = {
  type: "agent_message";
  id: string;
  ts: string;
  workflowRunId: string;
  messageType: string;
  senderRole: string;
  receiverRole: string | null;
  summary: string;
  payload: Record<string, unknown>;
};

export type TraderFeedEvent =
  | {
      type: "strategy_log";
      id: string;
      ts: string;
      runtimeId: string;
      level: string;
      message: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "news";
      id: string;
      ts: string;
      title: string;
      source: string;
    }
  | {
      type: "order";
      id: string;
      ts: string;
      side: string;
      symbol: string;
      qty: number;
      status: string;
      orderIntentId: string;
    };

export async function pollTraderFeed(input: {
  sessionId: string;
  workflowRunId?: string;
  symbol: string;
  exchange: string;
  since?: string;
  includeNews?: boolean;
}): Promise<{
  events: TraderFeedEvent[];
  drivers: TraderDriverEvent[];
  agentMessages: TraderAgentMessageEvent[];
  serverTime: string;
}> {
  const db = await getDb();
  const sym = input.symbol.trim().toUpperCase();
  const since = input.since ?? "1970-01-01T00:00:00.000Z";
  const events: TraderFeedEvent[] = [];
  const drivers: TraderDriverEvent[] = [];
  const agentMessages: TraderAgentMessageEvent[] = [];

  const runtimes = await listStrategyRuntimes({ sessionId: input.sessionId });
  for (const rt of runtimes) {
    if (rt.symbol.toUpperCase() !== sym) continue;
    const logs = await listStrategyRuntimeLogs(rt.id, 40, db);
    for (const log of logs) {
      if (log.createdAt <= since) continue;
      const payload = (log.payloadJson ?? {}) as Record<string, unknown>;
      const isExec =
        log.message === "buy_signal_executed" || log.message === "sell_signal_executed";
      if (isExec) {
        events.push({
          type: "strategy_log",
          id: log.id,
          ts: log.createdAt,
          runtimeId: rt.id,
          level: log.level,
          message: log.message,
          payload,
        });
      } else {
        drivers.push({
          type: "driver",
          id: `rtlog-${log.id}`,
          ts: log.createdAt,
          driverKind: "strategy_runtime",
          title: `策略运行时 · ${log.message}`,
          detail: `${rt.symbol} · ${rt.timeframe} · status=${rt.status}`,
          payload: { runtimeId: rt.id, level: log.level, ...payload },
        });
      }
    }
    if (rt.status === "running" && rt.updatedAt > since) {
      drivers.push({
        type: "driver",
        id: `rt-active-${rt.id}-${rt.updatedAt}`,
        ts: rt.updatedAt,
        driverKind: "strategy_runtime",
        title: "策略运行时已挂载",
        detail: `script=${rt.strategyScriptId.slice(0, 8)}… · ${rt.executionMode} · 等待信号评估`,
        payload: { runtimeId: rt.id },
      });
    }
  }

  const jobs = await db
    .select()
    .from(scheduledJob)
    .where(eq(scheduledJob.sessionId, input.sessionId))
    .orderBy(desc(scheduledJob.updatedAt))
    .limit(20);
  for (const job of jobs) {
    const runs = await db
      .select()
      .from(scheduledJobRun)
      .where(and(eq(scheduledJobRun.jobId, job.id), gt(scheduledJobRun.createdAt, since)))
      .orderBy(desc(scheduledJobRun.createdAt))
      .limit(5);
    for (const run of runs) {
      drivers.push({
        type: "driver",
        id: `jobrun-${run.id}`,
        ts: run.createdAt,
        driverKind: "scheduled_job",
        title: `定时任务 · ${job.name}`,
        detail: `status=${run.status}${run.errorMessage ? ` · ${run.errorMessage}` : ""}`,
        payload: {
          jobId: job.id,
          cronExpr: job.cronExpr,
          workflowRunId: run.workflowRunId,
          payloadJson: job.payloadJson,
        },
      });
    }
  }

  const commRows = await db
    .select()
    .from(communicationMessageLog)
    .where(
      and(
        eq(communicationMessageLog.direction, "inbound"),
        gt(communicationMessageLog.createdAt, since)
      )
    )
    .orderBy(desc(communicationMessageLog.createdAt))
    .limit(10);
  for (const row of commRows) {
    const p = (row.payloadJson ?? {}) as Record<string, unknown>;
    const text =
      typeof p.text === "string"
        ? p.text
        : typeof p.message === "string"
          ? p.message
          : JSON.stringify(p).slice(0, 200);
    drivers.push({
      type: "driver",
      id: `comm-${row.id}`,
      ts: row.createdAt,
      driverKind: "communication",
      title: `外部消息 · ${row.channelKind}`,
      detail: text,
      payload: p,
    });
  }

  const alerts = await db
    .select()
    .from(alertEvent)
    .where(gt(alertEvent.createdAt, since))
    .orderBy(desc(alertEvent.createdAt))
    .limit(15);
  for (const row of alerts) {
    const hay = `${row.title} ${row.alertType} ${JSON.stringify(row.detailsJson ?? {})}`.toUpperCase();
    if (!hay.includes(sym) && row.scopeType !== "system") continue;
    drivers.push({
      type: "driver",
      id: `alert-${row.id}`,
      ts: row.createdAt,
      driverKind: "alert",
      title: `告警 · ${row.alertType}`,
      detail: row.title,
      payload: (row.detailsJson ?? {}) as Record<string, unknown>,
    });
  }

  const intentWhere = input.workflowRunId
    ? and(eq(orderIntent.workflowRunId, input.workflowRunId), gt(orderIntent.intentTime, since))
    : and(eq(orderIntent.symbol, sym), gt(orderIntent.intentTime, since));

  const intents = await db
    .select()
    .from(orderIntent)
    .where(intentWhere)
    .orderBy(desc(orderIntent.intentTime))
    .limit(20);

  for (const intent of intents) {
    const tasks = await db
      .select()
      .from(executionTask)
      .where(eq(executionTask.orderIntentId, intent.id))
      .limit(1);
    events.push({
      type: "order",
      id: intent.id,
      ts: intent.intentTime,
      side: intent.side,
      symbol: intent.symbol ?? sym,
      qty: intent.qty,
      status: tasks[0]?.status ?? "pending",
      orderIntentId: intent.id,
    });
  }

  if (input.includeNews !== false) {
    try {
      const brief = await queryMarketNewsBrief({
        symbol: sym,
        exchange: input.exchange,
        limit: 5,
      });
      for (const n of brief.symbolNews.slice(0, 5)) {
        if (n.publishedAt <= since) continue;
        drivers.push({
          type: "driver",
          id: `news-${n.id}`,
          ts: n.publishedAt,
          driverKind: "news",
          title: `资讯驱动 · ${n.source}`,
          detail: n.title,
          payload: { url: n.url, content: n.content?.slice(0, 200) },
        });
      }
    } catch {
      /* news optional */
    }
  }

  const workflows = await db
    .select({ id: workflowRun.id })
    .from(workflowRun)
    .where(eq(workflowRun.sessionId, input.sessionId))
    .orderBy(desc(workflowRun.startedAt))
    .limit(30);
  const workflowIds = new Set(workflows.map((w) => w.id));
  if (input.workflowRunId) workflowIds.add(input.workflowRunId);

  if (workflowIds.size > 0) {
    const [instances, definitions, messages] = await Promise.all([
      db.select().from(agentInstance),
      db.select().from(agentDefinition),
      db.select().from(a2aMessage).orderBy(desc(a2aMessage.createdAt)).limit(200),
    ]);
    const defById = new Map(definitions.map((d) => [d.id, d]));
    const roleByInst = new Map(
      instances.map((i) => [i.id, defById.get(i.definitionId)?.role ?? "unknown"])
    );

    for (const m of messages) {
      if (!workflowIds.has(m.workflowRunId)) continue;
      if (m.createdAt <= since) continue;
      const payload = (m.payloadJson ?? {}) as Record<string, unknown>;
      const senderRole = roleByInst.get(m.senderInstanceId) ?? "unknown";
      const receiverRole = m.receiverInstanceId
        ? (roleByInst.get(m.receiverInstanceId) ?? "unknown")
        : null;
      const summary = summarizeA2APayload(m.messageType, payload);
      agentMessages.push({
        type: "agent_message",
        id: m.id,
        ts: m.createdAt,
        workflowRunId: m.workflowRunId,
        messageType: m.messageType,
        senderRole,
        receiverRole,
        summary,
        payload,
      });
    }
  }

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  drivers.sort((a, b) => a.ts.localeCompare(b.ts));
  agentMessages.sort((a, b) => a.ts.localeCompare(b.ts));
  return {
    events,
    drivers: drivers.slice(-80),
    agentMessages: agentMessages.slice(-80),
    serverTime: new Date().toISOString(),
  };
}

function summarizeA2APayload(messageType: string, payload: Record<string, unknown>): string {
  if (messageType === "ORDER_INTENT") {
    const p = payload as { ticker?: string; direction?: string; quantity?: number };
    return `订单意图 ${p.ticker ?? "?"} ${p.direction ?? ""} × ${p.quantity ?? "?"}`;
  }
  if (messageType === "TASK_ASSIGN") {
    const p = payload as { taskType?: string; goal?: string };
    return `任务分配 ${p.taskType ?? ""} ${(p.goal ?? "").slice(0, 80)}`;
  }
  if (messageType === "TASK_RESULT") {
    const p = payload as { status?: string; summary?: string };
    return `任务结果 ${p.status ?? ""} ${(p.summary ?? "").slice(0, 80)}`;
  }
  if (messageType === "RISK_BLOCK") {
    return `风控拦截 ${JSON.stringify(payload).slice(0, 120)}`;
  }
  return JSON.stringify(payload).slice(0, 160);
}

/** 解析用户自然语言指令（轻量规则） */
export function parseTraderUserCommand(text: string): {
  action: "buy" | "sell" | "cancel" | "ingest" | "unknown";
  qty?: number;
  orderIntentId?: string;
  raw: string;
} {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  if (/撤单|取消|cancel/.test(lower)) {
    const idMatch = raw.match(/[0-9a-f-]{8,}/i);
    return { action: "cancel", orderIntentId: idMatch?.[0], raw };
  }
  if (/买入|做多|buy|long/.test(lower)) {
    const n = raw.match(/(\d+)/);
    return { action: "buy", qty: n ? Number(n[1]) : 100, raw };
  }
  if (/卖出|做空|sell|short/.test(lower)) {
    const n = raw.match(/(\d+)/);
    return { action: "sell", qty: n ? Number(n[1]) : 100, raw };
  }
  if (/刷新|行情|ingest/.test(lower)) {
    return { action: "ingest", raw };
  }
  return { action: "unknown", raw };
}
