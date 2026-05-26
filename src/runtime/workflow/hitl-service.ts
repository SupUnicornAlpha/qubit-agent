import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, runInTransaction } from "../../db/sqlite/client";
import { workflowHitlRequest, workflowRun } from "../../db/sqlite/schema";
import type { LoopOptionsJson } from "../../types/loop";
import { parseLoopOptionsJson } from "../../types/loop";
import { graphRunner } from "../langgraph/graph-factory";
import { stepStreamBus } from "../langgraph/event-stream";
import type { StepStreamEvent } from "../langgraph/state";
import {
  findPendingAnalystJobByWorkflow,
  resumeAnalystResearchJob,
} from "../msa/analyst-research-jobs";
import { dispatchTaskToRole } from "../agent-pool";

export type HitlScope = "chat_orchestrator" | "team_orchestrator";
export type HitlRequestKind = "tool_call" | "team_research_plan";
export type HitlRequestStatus = "pending" | "approved" | "rejected";

export class HitlAwaitingApprovalError extends Error {
  readonly requestId: string;
  readonly workflowRunId: string;

  constructor(requestId: string, workflowRunId: string, message?: string) {
    super(message ?? "awaiting human approval");
    this.name = "HitlAwaitingApprovalError";
    this.requestId = requestId;
    this.workflowRunId = workflowRunId;
  }
}

export type HitlInputKind = "approve_only" | "single_choice" | "multi_choice" | "free_form";

export type HitlApprovalPayload = {
  requestId: string;
  decision: "approved" | "rejected";
  /**
   * HITL v2：用户实际选择/输入的内容。
   *   - approve_only / rejected → null
   *   - single_choice → { value: string }
   *   - multi_choice → { values: string[] }
   *   - free_form → { text: string }
   * 沿 hitlApproval 链路透传给下一轮 Orchestrator prompt，让规划吸收人工反馈。
   */
  response?: Record<string, unknown> | null;
};

export function parseHitlApproval(raw: unknown): HitlApprovalPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const requestId = typeof o.requestId === "string" ? o.requestId : "";
  const decision = o.decision === "approved" || o.decision === "rejected" ? o.decision : null;
  if (!requestId || !decision) return null;
  const response =
    o.response && typeof o.response === "object" ? (o.response as Record<string, unknown>) : null;
  return { requestId, decision, response };
}

/**
 * 高危工具：即便用户把 `hitlChatMode` 设为 'off'，命中以下名单也强制走 HITL。
 *
 * 入选标准（v2）：
 *   - **下单 / 交易类**：直接动钱、动仓位；任何形式的 broker/order/place_*
 *   - **修改外部状态**：自我修改 prompt（影响后续所有调用）、写入审计 / 配置类
 *   - **删除 / 清理类**：cleanup/delete/purge —— 不可逆
 *
 * 反过来，**常规读数据 / 计算 / 回测 / 报告生成** 都不在此列，'ai' 模式下不打扰。
 *
 * 这是"硬规则"而非穷举：用前缀 / 子串匹配兜住没注册到 BUILTIN_HANDLERS 的 MCP 工具
 * （如三方下单 MCP）；命名约定见 docs/HITL_REDESIGN.md §4。
 */
const HIGH_RISK_CHAT_TOOL_PATTERNS: ReadonlyArray<RegExp> = [
  // 下单 / 交易（broker_place_order / place_order / order_submit / ...）
  /(^|[_\-./])(place_order|submit_order|create_order|cancel_order|modify_order)([_\-./]|$)/i,
  /(^|[_\-./])(broker_[a-z]+_order|broker_order_[a-z]+)([_\-./]|$)/i,
  // 自修改 prompt / agent 定义（一旦改了影响所有后续推理）
  /(^|[_\-./])edit_agent_pack([_\-./]|$)/i,
  /(^|[_\-./])update_agent_definition([_\-./]|$)/i,
  // 删除 / 清理
  /(^|[_\-./])(delete|purge|wipe|reset)_[a-z_]+([_\-./]|$)/i,
];

export function isHighRiskChatTool(toolName: string): boolean {
  const name = toolName.trim();
  if (!name) return false;
  return HIGH_RISK_CHAT_TOOL_PATTERNS.some((re) => re.test(name));
}

export type ChatHitlTriggerDecision = {
  trigger: boolean;
  /** 'mode_always' 模式总是问；'rule_high_risk' 高危工具兜底；'mode_off' 关闭；'none' 不触发 */
  source: "mode_always" | "rule_high_risk" | "mode_off" | "none";
  reason: string;
};

/**
 * v2：对话 orchestrator HITL 评估器 —— 三档模式 + 高危工具硬规则兜底。
 *
 * 优先级：
 *   1. 高危工具命中 → 必触发（无视 mode）
 *   2. mode='always' → 触发（含 v1 旧行为 hitlChat:true）
 *   3. mode='off' → 不触发（含 v1 旧行为 hitlChat:false）
 *   4. mode='ai'（默认）→ 不触发（常规工具不打扰）
 *
 * 取代旧的 `resolveChatOrchestratorHitl` —— 后者无脑按 source==='chat' 全拦，
 * 导致用户体验"每调一个工具都得确认"。
 */
export function evaluateChatHitlTrigger(input: {
  workflow: { source: string; mode: string };
  loopOptions: LoopOptionsJson;
  role: string;
  toolName: string;
}): ChatHitlTriggerDecision {
  if (input.role !== "orchestrator") {
    return { trigger: false, source: "none", reason: "" };
  }
  // 高危工具：硬规则兜底，无视 mode
  if (isHighRiskChatTool(input.toolName)) {
    return {
      trigger: true,
      source: "rule_high_risk",
      reason: `高危工具需人工确认：${input.toolName}`,
    };
  }
  const mode = resolveChatHitlMode(input.loopOptions);
  if (mode === "always") {
    return {
      trigger: true,
      source: "mode_always",
      reason: "用户设置每次工具调用都需要人工确认",
    };
  }
  if (mode === "off") {
    return { trigger: false, source: "mode_off", reason: "" };
  }
  // 'ai' 模式：默认不打扰；常规工具直接放行。
  // 未来可扩展：让 LLM 在 reasonText 中输出结构化 hitl hint，命中即触发。
  return { trigger: false, source: "none", reason: "" };
}

/**
 * v1 兼容映射：
 *   - 显式设置过 `hitlChatMode` 优先；
 *   - 否则 `hitlChat:true → 'always'`，`hitlChat:false → 'off'`；
 *   - 都没设置 → 'ai'（v2 默认）。
 */
function resolveChatHitlMode(loopOptions: LoopOptionsJson): "off" | "ai" | "always" {
  if (loopOptions.hitlChatMode) return loopOptions.hitlChatMode;
  if (loopOptions.hitlChat === true) return "always";
  if (loopOptions.hitlChat === false) return "off";
  return "ai";
}

/** v1 `hitlTeam:true` 等价于 v2 `hitlMode:'always'`；缺省取 'ai' 作为默认。 */
function resolveHitlMode(loopOptions: LoopOptionsJson): "off" | "ai" | "always" {
  if (loopOptions.hitlMode) return loopOptions.hitlMode;
  if (loopOptions.hitlTeam === true) return "always";
  if (loopOptions.hitlTeam === false) return "off";
  return "ai";
}

/**
 * v2 评估输入：LLM 自评 + 上下文信号；用于 evaluateTeamHitlTrigger 决策。
 */
export type HitlHint = {
  /** Orchestrator 自评是否需要 HITL；undefined 时按 mode 默认 */
  needed?: boolean;
  /** 自评原因（短句，写入 UI 给用户看） */
  reason?: string;
  /** 自评推荐的交互形态；缺省 approve_only */
  inputKind?: HitlInputKind;
  /** 自评配套的选项（single/multi_choice 形态用） */
  options?: Array<{ label: string; value: string; description?: string }>;
};

export type HitlTriggerDecision = {
  trigger: boolean;
  reason: string;
  /** 命中的硬规则类型；纯 LLM 决定时为 'ai'；'always' 模式为 'mode_always'；off 模式无规则命中时 trigger=false */
  source: "mode_always" | "ai" | "rule_money" | "rule_scale" | "rule_retry" | "none";
  inputKind: HitlInputKind;
  options?: Array<{ label: string; value: string; description?: string }>;
};

/**
 * 评估"该不该 HITL"：三档模式 × 硬规则 × LLM 自评。
 *
 * 优先级：硬规则（无视 mode 都触发）> mode='always'（每次都触发）> mode='ai' 时看 LLM hint > mode='off' 不触发。
 *
 * 硬规则覆盖范围（v2 P1）：money / scale / retry；详见 docs/HITL_REDESIGN.md §4。
 */
export function evaluateTeamHitlTrigger(input: {
  workflow: { mode: string };
  loopOptions: LoopOptionsJson;
  symbols: string[];
  analystSlotCount: number;
  /** 同 (ticker, mode) 最近一次状态；'failed' 触发 retry 规则 */
  recentSameTickerStatus?: "completed" | "failed" | null;
  hitlHint?: HitlHint | null;
}): HitlTriggerDecision {
  const mode = resolveHitlMode(input.loopOptions);

  // 1) 硬规则：资金 — trade mode + 金额超阈值（v2 P1 取阈值默认 1000）
  if (input.workflow.mode === "trade") {
    const threshold = input.loopOptions.hitlMoneyThreshold ?? 1000;
    // TODO(v2-P2)：amount 当前未从 loopOptions 拿到，先以 mode=trade 作必触发，避免假阴；后续接 broker order ticket
    void threshold;
    return {
      trigger: true,
      source: "rule_money",
      reason: "涉及真实下单：mode=trade，需人工确认资金类操作",
      inputKind: "approve_only",
    };
  }

  // 2) 硬规则：规模 — symbols>5 或 analystSlotCount>6
  if (input.symbols.length > 5 || input.analystSlotCount > 6) {
    return {
      trigger: true,
      source: "rule_scale",
      reason: `规模较大：${input.symbols.length} 标的 / ${input.analystSlotCount} 分析师`,
      inputKind: input.hitlHint?.inputKind ?? "approve_only",
      options: input.hitlHint?.options,
    };
  }

  // 3) 硬规则：失败重试 — 同标的最近一次 failed
  if (input.recentSameTickerStatus === "failed") {
    return {
      trigger: true,
      source: "rule_retry",
      reason: "上次同标的分析失败，建议确认本次规划",
      inputKind: input.hitlHint?.inputKind ?? "approve_only",
      options: input.hitlHint?.options,
    };
  }

  // 4) mode='always'：每次都问（v1 行为兼容）
  if (mode === "always") {
    return {
      trigger: true,
      source: "mode_always",
      reason: "用户设置每次规划都人工确认",
      inputKind: input.hitlHint?.inputKind ?? "approve_only",
      options: input.hitlHint?.options,
    };
  }

  // 5) mode='ai'：看 LLM 自评
  if (mode === "ai" && input.hitlHint?.needed === true) {
    return {
      trigger: true,
      source: "ai",
      reason: input.hitlHint.reason ?? "Orchestrator 判定本次规划需要人工确认",
      inputKind: input.hitlHint.inputKind ?? "approve_only",
      options: input.hitlHint.options,
    };
  }

  // 6) 其他 — 不触发
  return {
    trigger: false,
    source: "none",
    reason: "",
    inputKind: "approve_only",
  };
}

export function shouldHitlGateToolCall(toolName: string): boolean {
  return toolName !== "run_analyst_team";
}

export async function loadWorkflowLoopContext(workflowRunId: string): Promise<{
  workflow: typeof workflowRun.$inferSelect;
  loopOptions: LoopOptionsJson;
}> {
  const db = await getDb();
  const rows = await db.select().from(workflowRun).where(eq(workflowRun.id, workflowRunId)).limit(1);
  const workflow = rows[0];
  if (!workflow) throw new Error(`workflow_run not found: ${workflowRunId}`);
  return { workflow, loopOptions: parseLoopOptionsJson(workflow.loopOptionsJson) };
}

export async function getHitlRequest(requestId: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowHitlRequest)
    .where(eq(workflowHitlRequest.id, requestId))
    .limit(1);
  return rows[0] ?? null;
}

export async function verifyHitlApproval(
  requestId: string,
  workflowRunId: string
): Promise<{ approved: boolean; rejected: boolean }> {
  const row = await getHitlRequest(requestId);
  if (!row || row.workflowRunId !== workflowRunId) {
    return { approved: false, rejected: false };
  }
  return {
    approved: row.status === "approved",
    rejected: row.status === "rejected",
  };
}

function publishHitlStreamEvent(input: {
  runId: string;
  workflowId: string;
  traceId: string;
  role: string;
  stepIndex: number;
  requestId: string;
  title: string;
  summary: string;
  scope: HitlScope;
  requestKind: HitlRequestKind;
}): void {
  const event: StepStreamEvent = {
    runId: input.runId,
    workflowId: input.workflowId,
    traceId: input.traceId,
    role: input.role,
    type: "hitl_request",
    stepIndex: input.stepIndex,
    ts: Date.now(),
    payload: {
      requestId: input.requestId,
      title: input.title,
      summary: input.summary,
      scope: input.scope,
      requestKind: input.requestKind,
    },
    loopKind: "native",
    source: "native",
  };
  stepStreamBus.publish(event);
}

export async function createHitlRequest(input: {
  workflowRunId: string;
  runId: string;
  traceId: string;
  role: string;
  stepIndex: number;
  agentInstanceId?: string;
  scope: HitlScope;
  requestKind: HitlRequestKind;
  title: string;
  summary: string;
  payloadJson: Record<string, unknown>;
  /** HITL v2：交互形态分发；不指定默认 approve_only（向后兼容） */
  inputKind?: HitlInputKind;
  /**
   * v2：渲染所需 schema —— single_choice/multi_choice 必带 `options: [{label,value,description?}]`；
   * free_form 可带 `placeholder/maxLength`；approve_only 留 `{}`。
   */
  inputSchema?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const db = await getDb();
  const id = randomUUID();

  /**
   * P0-3：原本是「insert hitl_request → update workflow_run」两条裸 SQL，第二步
   * SQLITE_BUSY 抖动失败会留下「hitl_request=pending 但 workflow_run.status 还在
   * running」的半成品（前端 banner 看到 pending、但状态条不显示审批中），
   * 之后只能靠 graph-factory.ts:559 / research-team-execute.ts:230 的兜底再补写。
   * 这里直接放进事务消灭这道偏差。
   *
   * SSE event 留在事务**之外**发：commit 后再 publish，避免事务回滚但前端已经看到 banner。
   */
  await runInTransaction(db, async () => {
    await db.insert(workflowHitlRequest).values({
      id,
      workflowRunId: input.workflowRunId,
      runId: input.runId,
      agentInstanceId: input.agentInstanceId ?? null,
      stepIndex: input.stepIndex,
      scope: input.scope,
      requestKind: input.requestKind,
      status: "pending",
      title: input.title.slice(0, 500),
      summary: input.summary.slice(0, 8000),
      payloadJson: input.payloadJson,
      inputKind: input.inputKind ?? "approve_only",
      inputSchemaJson: (input.inputSchema ?? {}) as never,
    });
    await db
      .update(workflowRun)
      .set({ status: "awaiting_approval", endedAt: null })
      .where(eq(workflowRun.id, input.workflowRunId));
  });

  publishHitlStreamEvent({
    runId: input.runId,
    workflowId: input.workflowRunId,
    traceId: input.traceId,
    role: input.role,
    stepIndex: input.stepIndex,
    requestId: id,
    title: input.title,
    summary: input.summary,
    scope: input.scope,
    requestKind: input.requestKind,
  });

  return { id };
}

export async function pauseForTeamOrchestratorHitl(input: {
  workflowRunId: string;
  runId: string;
  traceId: string;
  stepIndex?: number;
  ticker: string;
  planBrief: string;
  slotRoles: string[];
  /** 涉及的标的列表（basket 多标的）；用于硬规则 scale 判定 */
  symbols?: string[];
  /** Orchestrator LLM 自评的 HITL 提示（v2 P1）；undefined 时按 mode 默认 */
  hitlHint?: HitlHint | null;
  hitlApproval?: HitlApprovalPayload | null;
}): Promise<void> {
  if (input.hitlApproval?.decision === "rejected") {
    throw new HitlAwaitingApprovalError("", input.workflowRunId, "team orchestrator hitl rejected");
  }
  if (input.hitlApproval?.requestId) {
    const v = await verifyHitlApproval(input.hitlApproval.requestId, input.workflowRunId);
    if (v.approved) return;
    if (v.rejected) {
      throw new HitlAwaitingApprovalError(
        input.hitlApproval.requestId,
        input.workflowRunId,
        "team orchestrator hitl rejected"
      );
    }
  }

  const { workflow, loopOptions } = await loadWorkflowLoopContext(input.workflowRunId);

  // v2：硬规则 retry — 查同 ticker 最近一次状态
  const recentSameTickerStatus = await getRecentSameTickerStatus(input.ticker, workflow.mode);

  const decision = evaluateTeamHitlTrigger({
    workflow: { mode: workflow.mode },
    loopOptions,
    symbols: input.symbols ?? [input.ticker],
    analystSlotCount: input.slotRoles.length,
    recentSameTickerStatus,
    hitlHint: input.hitlHint ?? null,
  });
  if (!decision.trigger) return;

  const titlePrefix =
    decision.source === "rule_money"
      ? "[资金风险] "
      : decision.source === "rule_scale"
        ? "[大规模任务] "
        : decision.source === "rule_retry"
          ? "[重试确认] "
          : "";
  const title = `${titlePrefix}研究团队 Orchestrator 规划待确认：${input.ticker}`;
  // 把触发原因拼进 summary 顶部，让用户立刻看到"为什么这次需要审批"。
  const reasonHeader = decision.reason ? `[HITL 原因] ${decision.reason}\n\n` : "";
  const summary = (reasonHeader + input.planBrief).slice(0, 8000);

  const inputSchema =
    decision.inputKind === "single_choice" || decision.inputKind === "multi_choice"
      ? { options: decision.options ?? [] }
      : decision.inputKind === "free_form"
        ? { placeholder: "请用一句话告诉 Orchestrator 你的侧重点", maxLength: 500 }
        : {};

  const { id } = await createHitlRequest({
    workflowRunId: input.workflowRunId,
    runId: input.runId,
    traceId: input.traceId,
    role: "orchestrator",
    stepIndex: input.stepIndex ?? 0,
    scope: "team_orchestrator",
    requestKind: "team_research_plan",
    title,
    summary,
    payloadJson: {
      ticker: input.ticker,
      symbols: input.symbols ?? [input.ticker],
      slotRoles: input.slotRoles,
      planBrief: input.planBrief,
      triggerSource: decision.source,
      triggerReason: decision.reason,
    },
    inputKind: decision.inputKind,
    inputSchema,
  });
  throw new HitlAwaitingApprovalError(id, input.workflowRunId, title);
}

/**
 * 查询同 (ticker, mode) 最近一次 workflow 的状态（24h 内）。
 *
 * 现状：workflow_run 没有 ticker 字段，goal 文本里通常含 "· TICKER ·" 串
 * （见 analyst.routes.ts 的 displayLabel 拼装）；用 LIKE 兜底匹配，精确性后续
 * 加 ticker 列时再升级（v2-P2）。仅取最近"已结束"的状态，跳过 running 等。
 */
async function getRecentSameTickerStatus(
  ticker: string,
  mode: string
): Promise<"completed" | "failed" | null> {
  if (!ticker.trim()) return null;
  const db = await getDb();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const pattern = `%${ticker.trim()}%`;
  // 注意：workflowRun schema 字段是 `startedAt`（列名 created_at），表对象上**没有**
  // `createdAt` 属性。若写成 workflowRun.createdAt 会得到 undefined，drizzle 在
  // _prepare → orderSelectedFields 递归时会触发 `Object.entries(undefined)` → boom。
  const rows = await db
    .select({ status: workflowRun.status, startedAt: workflowRun.startedAt })
    .from(workflowRun)
    .where(
      and(
        eq(workflowRun.mode, mode),
        sql`${workflowRun.goal} LIKE ${pattern}`,
        sql`${workflowRun.startedAt} >= ${oneDayAgo}`
      )
    )
    .orderBy(desc(workflowRun.startedAt))
    .limit(5);
  for (const r of rows) {
    if (r.status === "completed") return "completed";
    if (r.status === "failed") return "failed";
  }
  return null;
}

export async function resolveHitlRequest(input: {
  requestId: string;
  decision: "approved" | "rejected";
  resolvedBy?: string;
  /** v2：用户在 single_choice/free_form 等形态下提交的内容，会写入 response_json 并透传给下一轮 Orchestrator */
  response?: Record<string, unknown> | null;
}): Promise<{ workflowRunId: string; resumed: boolean; runId?: string; idempotent?: boolean }> {
  const db = await getDb();
  const row = await getHitlRequest(input.requestId);
  if (!row) throw new Error("hitl request not found");
  /**
   * 幂等：用户/前端可能因双击、UI 状态未同步、SSE 重连等原因发起重复 POST。
   * 已经 approved/rejected 时不抛 500，而是返回 idempotent=true 让前端正常清状态；
   * 这样既不会让前端卡在"按钮还在 + 撞 already approved 500"的死状态，
   * 也不重复触发 resume 逻辑（避免重派一次 graphRunner.resumeRoleTask 导致 graph 跑两遍）。
   */
  if (row.status !== "pending") {
    console.warn(
      `[hitl] resolveHitlRequest idempotent: request=${input.requestId} already ${row.status} (caller decision=${input.decision})`
    );
    return { workflowRunId: row.workflowRunId, resumed: false, idempotent: true };
  }

  const now = new Date().toISOString();

  /**
   * P0-3：原本是 4 张表（workflow_hitl_request / workflow_run / analyst_research_job /
   * 进程内 cache）依次裸 update，中间任意一步崩溃会留下「hitl_request 已 approved 但
   * analyst job 还卡 awaiting_approval」式的死锁 —— restoreRunningWorkflows 也救不了，
   * 因为 hitl_request 已经不是 pending。
   *
   * 这里把 3 张表的 status 写入合并进事务：要么一起成功，要么一起 rollback。
   * 副作用（A2A dispatch / graphRunner.resumeRoleTask）放事务**之外**，留给
   * restoreRunningWorkflows 兜底 sweep 在重启后补救。
   */
  type ResolveTxOutcome =
    | { kind: "rejected" }
    | {
        kind: "approved_team";
        jobId: string;
        resumePayload: import("../msa/analyst-research-jobs").AnalystResearchJob["resumePayload"];
        workflowRow: typeof workflowRun.$inferSelect;
      }
    | {
        kind: "approved_chat";
        workflowRow: typeof workflowRun.$inferSelect;
      }
    | { kind: "missing_resume_payload" };

  const outcome = await runInTransaction(db, async (): Promise<ResolveTxOutcome> => {
    await db
      .update(workflowHitlRequest)
      .set({
        status: input.decision,
        resolvedAt: now,
        resolvedBy: input.resolvedBy ?? "user",
        responseJson: (input.response ?? null) as never,
      })
      .where(eq(workflowHitlRequest.id, input.requestId));

    if (input.decision === "rejected") {
      await db
        .update(workflowRun)
        .set({ status: "failed", endedAt: now })
        .where(eq(workflowRun.id, row.workflowRunId));
      if (row.scope === "team_orchestrator") {
        const { failAnalystResearchJob } = await import("../msa/analyst-research-jobs");
        const pending = await findPendingAnalystJobByWorkflow(row.workflowRunId);
        if (pending) {
          await failAnalystResearchJob(pending.jobId, new Error("rejected by human reviewer"));
        }
      }
      return { kind: "rejected" };
    }

    await db
      .update(workflowRun)
      .set({ status: "running", endedAt: null })
      .where(eq(workflowRun.id, row.workflowRunId));

    const wfRows = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, row.workflowRunId))
      .limit(1);
    const wfInner = wfRows[0];
    if (!wfInner) throw new Error("workflow_run missing after hitl approve");

    if (row.scope === "team_orchestrator") {
      const pending = await findPendingAnalystJobByWorkflow(row.workflowRunId);
      const resumePayload = pending ? await resumeAnalystResearchJob(pending.jobId) : undefined;
      if (!pending || !resumePayload) {
        /**
         * P0-2 之后 DB 永远存着 resumePayload，只有 DB 行被外部 manual 删除 /
         * migration 故障才会到这；此时把 workflow_run 在同一事务内回到 failed，
         * 不再像旧代码那样在事务外再发一条 UPDATE 让状态串到 running→failed。
         */
        await db
          .update(workflowRun)
          .set({ status: "failed", endedAt: new Date().toISOString() })
          .where(eq(workflowRun.id, row.workflowRunId));
        return { kind: "missing_resume_payload" };
      }
      return {
        kind: "approved_team",
        jobId: pending.jobId,
        resumePayload,
        workflowRow: wfInner,
      };
    }
    return { kind: "approved_chat", workflowRow: wfInner };
  });

  // 事务提交后再做副作用（dispatch / resume / SSE）。崩溃只会丢"派发动作"，状态机一致。
  if (outcome.kind === "rejected") {
    return { workflowRunId: row.workflowRunId, resumed: false };
  }
  if (outcome.kind === "missing_resume_payload") {
    throw new Error(
      "research_team_execute resume payload missing (analyst_research_job row absent or corrupt); please re-run the analysis"
    );
  }

  if (outcome.kind === "approved_team") {
    const { jobId, resumePayload } = outcome;
    if (!resumePayload) {
      throw new Error("invariant: approved_team outcome must have resumePayload");
    }
    await dispatchTaskToRole({
      workflowId: row.workflowRunId,
      role: "orchestrator",
      payload: {
        taskId: randomUUID(),
        taskType: "research_team_execute",
        assignedRole: "orchestrator",
        params: {
          jobId,
          ticker: resumePayload.ticker,
          scope: resumePayload.scope ?? undefined,
          context: resumePayload.context,
          agentGroupId: resumePayload.agentGroupId ?? undefined,
          analystRoles: resumePayload.analystRoles ?? undefined,
          analystDefinitionIds: resumePayload.analystDefinitionIds ?? undefined,
          hitlApproval: {
            requestId: input.requestId,
            decision: "approved",
            response: input.response ?? null,
          },
        },
      },
    });

    return { workflowRunId: row.workflowRunId, resumed: true, runId: jobId };
  }

  const wf = outcome.workflowRow;
  const result = await graphRunner.resumeRoleTask({
    workflowId: row.workflowRunId,
    role: "orchestrator",
    payload: {
      taskId: randomUUID(),
      taskType: "workflow_resume",
      assignedRole: "orchestrator",
      params: {
        workflowRunId: row.workflowRunId,
        goal: wf.goal,
        mode: wf.mode,
        hitlApproval: {
          requestId: input.requestId,
          decision: "approved",
          response: input.response ?? null,
        },
        hitlPayload: row.payloadJson as Record<string, unknown>,
      },
    },
  });

  return { workflowRunId: row.workflowRunId, resumed: result.resumed, runId: result.runId };
}

export async function listPendingHitlRequests(workflowRunId: string) {
  const db = await getDb();
  return db
    .select()
    .from(workflowHitlRequest)
    .where(
      and(
        eq(workflowHitlRequest.workflowRunId, workflowRunId),
        eq(workflowHitlRequest.status, "pending")
      )
    )
    .orderBy(desc(workflowHitlRequest.createdAt));
}
