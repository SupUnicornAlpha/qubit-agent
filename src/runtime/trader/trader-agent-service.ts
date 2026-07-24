import { and, desc, eq, gt } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  alertEvent,
  brokerOrder,
  communicationMessageLog,
  executionTask,
  orderIntent,
  scheduledJob,
  scheduledJobRun,
} from "../../db/sqlite/schema";
import type { OrderSide, OrderType } from "../../types/entities";
import type { BrokerProvider } from "../../types/broker";
import { processExecutionTasks } from "../execution/execution-worker";
import {
  createOrderIntentFromReiaPayload,
  resolveExecutionStrategyContext,
} from "../execution/reia-bridge";
import { createBracketOrder } from "../execution/bracket-order-service";
import { brokerCancelOrder } from "../execution/broker/broker-service";
import { queryMarketNewsBrief } from "../market/news-brief-query";
import { listStrategyRuntimeLogs } from "../strategy/strategy-runtime-log";
import { listStrategyRuntimes } from "../strategy/strategy-runtime-service";
import {
  appendTraderContextMessage,
  getTraderContextTail,
  listTraderContextMessages,
} from "./trader-context-store";
import { getOrCreateTraderWorkflow, TRADER_WORKFLOW_GOAL } from "./trader-workflow";

export interface TraderSessionContext {
  workflowRunId: string;
  projectId: string;
  sessionId: string;
  created: boolean;
}

export { TRADER_WORKFLOW_GOAL };

export async function ensureTraderSession(input: {
  projectId: string;
  sessionId: string;
}): Promise<TraderSessionContext> {
  const { workflowRunId, created } = await getOrCreateTraderWorkflow(input);

  if (created) {
    await appendTraderContextMessage({
      workflowRunId,
      sourceId: `session-init-${workflowRunId}`,
      role: "system",
      kind: "session_init",
      title: "实时交易上下文已建立",
      body: `projectId=${input.projectId}\nsessionId=${input.sessionId}\n后续驱动与指令将追加为消息，不再新建 workflow。`,
    });
  }

  return {
    workflowRunId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    created,
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
  side: OrderSide;
  qty: number;
  price?: number | null;
  /** P2-E：与 entities.OrderType 子集对齐（trader 暂只支持市价/限价） */
  orderType?: Extract<OrderType, "market" | "limit">;
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

  await appendTraderContextMessage({
    workflowRunId: input.workflowRunId,
    sourceId: `order-${result.orderIntentId}`,
    role: "user",
    kind: "order",
    title: `${input.side === "buy" ? "买入" : "卖出"} ${sym} × ${qty}`,
    body: `risk=${result.riskOutcome}\n${result.riskReason}\nintent=${result.orderIntentId}`,
    payload: {
      orderIntentId: result.orderIntentId,
      side: input.side,
      symbol: sym,
      qty,
    },
  });

  return {
    orderIntentId: result.orderIntentId,
    executionTaskId: result.executionTaskId,
    legacyIntentOrderId: result.legacyIntentOrderId,
    riskOutcome: result.riskOutcome,
    riskReason: result.riskReason,
  };
}

export async function placeTraderBracketOrder(input: {
  workflowRunId: string;
  symbol: string;
  exchange: string;
  side: OrderSide;
  qty: number;
  entryOrderType: "market" | "limit";
  entryReferencePrice: number;
  entryLimitPrice?: number | null;
  takeProfitPrice: number;
  stopLossPrice: number;
  timeframe?: string;
  executionMode?: "paper" | "live";
  brokerAccountId?: string;
}) {
  const symbol = input.symbol.trim().toUpperCase();
  const market = chartExchangeToMarket(input.exchange);
  const db = await getDb();
  const context = await resolveExecutionStrategyContext(db, input.workflowRunId, symbol, market);
  const result = await createBracketOrder(db, {
    workflowRunId: input.workflowRunId,
    strategyVersionId: context.strategyVersionId,
    instrumentId: context.instrumentId,
    side: input.side,
    qty: input.qty,
    entryOrderType: input.entryOrderType,
    entryReferencePrice: input.entryReferencePrice,
    ...(input.entryLimitPrice != null ? { entryLimitPrice: input.entryLimitPrice } : {}),
    takeProfitPrice: input.takeProfitPrice,
    stopLossPrice: input.stopLossPrice,
    timeInForce: "gtc",
    dispatchMode: input.executionMode ?? "paper",
    ...(input.brokerAccountId ? { brokerAccountId: input.brokerAccountId } : {}),
    market,
    symbol,
  });
  await processExecutionTasks(db);
  await appendTraderContextMessage({
    workflowRunId: input.workflowRunId,
    sourceId: `bracket-${result.bracketId}`,
    role: "user",
    kind: "bracket_order",
    title: `${input.side === "buy" ? "做多" : "做空"} ${symbol} · Bracket`,
    body: `entry=${input.entryReferencePrice}\ntakeProfit=${input.takeProfitPrice}\nstopLoss=${input.stopLossPrice}\nbracket=${result.bracketId}`,
    payload: { ...result },
  });
  return result;
}

export async function cancelTraderOrder(input: {
  orderIntentId?: string;
  brokerOrderId?: string;
  provider?: BrokerProvider;
  workflowRunId?: string;
}): Promise<{ cancelled: boolean; detail: string }> {
  const db = await getDb();

  if (input.brokerOrderId) {
    await brokerCancelOrder({
      provider: input.provider ?? "futu",
      brokerOrderId: input.brokerOrderId,
    });
    if (input.workflowRunId) {
      await appendTraderContextMessage({
        workflowRunId: input.workflowRunId,
        sourceId: `cancel-broker-${input.brokerOrderId}`,
        role: "user",
        kind: "cancel",
        title: "撤单（券商单）",
        body: input.brokerOrderId,
      });
    }
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
    if (input.workflowRunId) {
      await appendTraderContextMessage({
        workflowRunId: input.workflowRunId,
        sourceId: `cancel-intent-${input.orderIntentId}`,
        role: "user",
        kind: "cancel",
        title: "撤单（未报券商）",
        body: input.orderIntentId,
      });
    }
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

  if (input.workflowRunId) {
    await appendTraderContextMessage({
      workflowRunId: input.workflowRunId,
      sourceId: `cancel-intent-${input.orderIntentId}`,
      role: "user",
      kind: "cancel",
      title: "撤单成功",
      body: bo.brokerOrderId,
    });
  }
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

export type TraderContextMessageDto = {
  id: string;
  ts: string;
  role: string;
  kind: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
};

async function recordFeedToContext(
  workflowRunId: string,
  items: Array<{
    sourceId: string;
    role: "driver" | "agent" | "system";
    kind: string;
    title: string;
    body: string;
    payload?: Record<string, unknown>;
  }>
): Promise<void> {
  for (const item of items) {
    await appendTraderContextMessage({
      workflowRunId,
      sourceId: item.sourceId,
      role: item.role,
      kind: item.kind,
      title: item.title,
      body: item.body,
      payload: item.payload,
    });
  }
}

export async function pollTraderFeed(input: {
  sessionId: string;
  workflowRunId: string;
  symbol: string;
  exchange: string;
  since?: string;
  includeNews?: boolean;
}): Promise<{
  events: TraderFeedEvent[];
  drivers: TraderDriverEvent[];
  agentMessages: TraderAgentMessageEvent[];
  contextMessages: TraderContextMessageDto[];
  serverTime: string;
}> {
  const db = await getDb();
  const sym = input.symbol.trim().toUpperCase();
  const since = input.since ?? "1970-01-01T00:00:00.000Z";
  const events: TraderFeedEvent[] = [];
  const drivers: TraderDriverEvent[] = [];
  const agentMessages: TraderAgentMessageEvent[] = [];
  const toContext: Parameters<typeof recordFeedToContext>[1] = [];

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
        toContext.push({
          sourceId: `rtlog-${log.id}`,
          role: "driver",
          kind: "strategy_signal",
          title: isExec ? `策略${log.message === "buy_signal_executed" ? "买入" : "卖出"}` : log.message,
          body: `${rt.symbol} · ${rt.timeframe}`,
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
        toContext.push({
          sourceId: `rtlog-${log.id}`,
          role: "driver",
          kind: "strategy_runtime",
          title: `策略运行时 · ${log.message}`,
          body: `${rt.symbol} · ${rt.timeframe} · status=${rt.status}`,
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
      toContext.push({
        sourceId: `jobrun-${run.id}`,
        role: "driver",
        kind: "scheduled_job",
        title: `定时任务 · ${job.name}`,
        body: `status=${run.status}`,
        payload: { jobId: job.id, cronExpr: job.cronExpr },
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
    toContext.push({
      sourceId: `comm-${row.id}`,
      role: "driver",
      kind: "communication",
      title: `外部消息 · ${row.channelKind}`,
      body: text,
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
    toContext.push({
      sourceId: `alert-${row.id}`,
      role: "driver",
      kind: "alert",
      title: `告警 · ${row.alertType}`,
      body: row.title,
      payload: (row.detailsJson ?? {}) as Record<string, unknown>,
    });
  }

  const intents = await db
    .select()
    .from(orderIntent)
    .where(
      and(eq(orderIntent.workflowRunId, input.workflowRunId), gt(orderIntent.intentTime, since))
    )
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
        toContext.push({
          sourceId: `news-${n.id}`,
          role: "driver",
          kind: "news",
          title: `资讯 · ${n.source}`,
          body: n.title,
          payload: { url: n.url },
        });
      }
    } catch {
      /* news optional */
    }
  }

  await recordFeedToContext(input.workflowRunId, toContext);

  const ctxRows = await getTraderContextTail(input.workflowRunId, 120);
  const contextMessages: TraderContextMessageDto[] = ctxRows.map((r) => ({
    id: r.id,
    ts: r.createdAt,
    role: r.role,
    kind: r.kind,
    title: r.title,
    body: r.body,
    payload: (r.payloadJson ?? {}) as Record<string, unknown>,
  }));

  events.sort((a, b) => a.ts.localeCompare(b.ts));
  drivers.sort((a, b) => a.ts.localeCompare(b.ts));
  return {
    events,
    drivers: drivers.slice(-80),
    agentMessages: agentMessages.slice(-80),
    contextMessages,
    serverTime: new Date().toISOString(),
  };
}

export async function appendTraderUserMessage(input: {
  workflowRunId: string;
  text: string;
  kind?: string;
}): Promise<{ id: string; compressed: boolean }> {
  const { id, compressed } = await appendTraderContextMessage({
    workflowRunId: input.workflowRunId,
    role: "user",
    kind: input.kind ?? "user_text",
    title: "用户指令",
    body: input.text.trim(),
  });
  return { id, compressed };
}

export async function getTraderContext(input: {
  workflowRunId: string;
}): Promise<TraderContextMessageDto[]> {
  const rows = await listTraderContextMessages(input.workflowRunId);
  return rows.map((r) => ({
    id: r.id,
    ts: r.createdAt,
    role: r.role,
    kind: r.kind,
    title: r.title,
    body: r.body,
    payload: (r.payloadJson ?? {}) as Record<string, unknown>,
  }));
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
