/**
 * 监控 · 失败列表（summary level）
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §4.1.2）：
 *   - 跨维度（tool / mcp / skill / agent）查询最近窗口内的失败/超时事件
 *   - 仅返回**摘要级**字段（errorMessage / status / stepIndex / workflowRunId / ts），
 *     避免在监控面板上拉重 JSON（请求体 / 响应体）；详情用 workflow detail 路由再拉
 *   - 时间窗口默认 60 分钟、limit 默认 20、上限 100
 *
 * scope 含义：
 *   - tool   ： tool_call_log.status ∈ {error, timeout, sandbox_blocked}
 *   - mcp    ： mcp_call_log.status ∈ {timeout, failed, sandbox_blocked}
 *   - skill  ： agent_skill_run.outcome === 'fail'
 *   - agent  ： agent_instance.status === 'error'（拿 errorMessage 兜底）
 *   - 不传  ： 4 个 scope 各取窗口内最近事件，按时间合并 sort
 */
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentSkill,
  agentSkillRun,
  agentStep,
  mcpCallLog,
  toolCallLog,
  workflowRun,
} from "../../db/sqlite/schema";

export type FailureScope = "tool" | "mcp" | "skill" | "agent";

export type FailureRow = {
  id: string;
  scope: FailureScope;
  name: string;
  status: string;
  errorMessage: string | null;
  stepIndex: number | null;
  workflowRunId: string | null;
  ts: string;
};

export type FailureListInput = {
  /** 不传则查 4 类失败合并返回 */
  scope?: FailureScope;
  /** 时间窗口（分钟），默认 60，最大 1440 */
  windowMinutes?: number;
  /** 单 scope 返回上限，默认 20，最大 100 */
  limit?: number;
  /** session 过滤；不传查全局 */
  sessionId?: string;
};

/**
 * 列出 `tool_call_log.status` / `mcp_call_log.status` 中视为「失败」的枚举值。
 * 不用 `as const` tuple 是为了让 drizzle `inArray` 的元素类型与列的 enum union 兼容
 * （readonly tuple 会被推断为字面量类型，导致 drizzle 重载匹配失败）。
 */
const FAIL_TOOL_STATUSES: ("error" | "timeout" | "sandbox_blocked")[] = [
  "error",
  "timeout",
  "sandbox_blocked",
];
const FAIL_MCP_STATUSES: ("timeout" | "failed" | "sandbox_blocked")[] = [
  "timeout",
  "failed",
  "sandbox_blocked",
];

export async function listFailures(input?: FailureListInput): Promise<FailureRow[]> {
  const windowMinutes = clampInt(input?.windowMinutes ?? 60, 1, 1440);
  const limit = clampInt(input?.limit ?? 20, 1, 100);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const scope = input?.scope;
  const sessionId = input?.sessionId;

  const scopes: FailureScope[] = scope ? [scope] : ["tool", "mcp", "skill", "agent"];
  const results: FailureRow[] = [];

  for (const s of scopes) {
    switch (s) {
      case "tool":
        results.push(...(await listToolFailures(sinceIso, limit, sessionId)));
        break;
      case "mcp":
        results.push(...(await listMcpFailures(sinceIso, limit, sessionId)));
        break;
      case "skill":
        results.push(...(await listSkillFailures(sinceIso, limit, sessionId)));
        break;
      case "agent":
        results.push(...(await listAgentFailures(sinceIso, limit, sessionId)));
        break;
    }
  }

  results.sort((a, b) => b.ts.localeCompare(a.ts));
  // 合并多 scope 时仍按总 limit 返回（避免单类把额度吃光）
  return scope ? results : results.slice(0, limit * scopes.length);
}

// ─────────────────────────── tool ───────────────────────────

async function listToolFailures(
  sinceIso: string,
  limit: number,
  sessionId: string | undefined
): Promise<FailureRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: toolCallLog.id,
      toolName: toolCallLog.toolName,
      status: toolCallLog.status,
      errorMessage: toolCallLog.errorMessage,
      createdAt: toolCallLog.createdAt,
      stepIndex: agentStep.stepIndex,
      workflowRunId: agentStep.workflowRunId,
      workflowSessionId: workflowRun.sessionId,
    })
    .from(toolCallLog)
    .innerJoin(agentStep, eq(agentStep.id, toolCallLog.agentStepId))
    .innerJoin(workflowRun, eq(workflowRun.id, agentStep.workflowRunId))
    .where(
      and(
        inArray(toolCallLog.status, FAIL_TOOL_STATUSES),
        gte(toolCallLog.createdAt, sinceIso),
        sessionId ? eq(workflowRun.sessionId, sessionId) : undefined
      )
    )
    .orderBy(desc(toolCallLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    scope: "tool",
    name: r.toolName,
    status: r.status,
    errorMessage: r.errorMessage ?? null,
    stepIndex: r.stepIndex ?? null,
    workflowRunId: r.workflowRunId ?? null,
    ts: r.createdAt,
  }));
}

// ─────────────────────────── mcp ───────────────────────────

async function listMcpFailures(
  sinceIso: string,
  limit: number,
  sessionId: string | undefined
): Promise<FailureRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: mcpCallLog.id,
      serverName: mcpCallLog.serverName,
      toolName: mcpCallLog.toolName,
      status: mcpCallLog.status,
      errorCode: mcpCallLog.errorCode,
      createdAt: mcpCallLog.createdAt,
      stepIndex: agentStep.stepIndex,
      workflowRunId: mcpCallLog.workflowRunId,
      workflowSessionId: workflowRun.sessionId,
    })
    .from(mcpCallLog)
    .innerJoin(agentStep, eq(agentStep.id, mcpCallLog.agentStepId))
    .innerJoin(workflowRun, eq(workflowRun.id, mcpCallLog.workflowRunId))
    .where(
      and(
        inArray(mcpCallLog.status, FAIL_MCP_STATUSES),
        gte(mcpCallLog.createdAt, sinceIso),
        sessionId ? eq(workflowRun.sessionId, sessionId) : undefined
      )
    )
    .orderBy(desc(mcpCallLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    scope: "mcp",
    name: `${r.serverName}.${r.toolName}`,
    status: r.status,
    errorMessage: r.errorCode ?? null,
    stepIndex: r.stepIndex ?? null,
    workflowRunId: r.workflowRunId,
    ts: r.createdAt,
  }));
}

// ─────────────────────────── skill ───────────────────────────

async function listSkillFailures(
  sinceIso: string,
  limit: number,
  sessionId: string | undefined
): Promise<FailureRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: agentSkillRun.id,
      skillName: agentSkill.name,
      outcome: agentSkillRun.outcome,
      notes: agentSkillRun.notes,
      startedAt: agentSkillRun.startedAt,
      workflowRunId: agentSkillRun.workflowRunId,
      workflowSessionId: workflowRun.sessionId,
    })
    .from(agentSkillRun)
    .innerJoin(agentSkill, eq(agentSkill.id, agentSkillRun.skillId))
    .leftJoin(workflowRun, eq(workflowRun.id, agentSkillRun.workflowRunId))
    .where(
      and(
        eq(agentSkillRun.outcome, "fail"),
        gte(agentSkillRun.startedAt, sinceIso),
        sessionId ? eq(workflowRun.sessionId, sessionId) : undefined
      )
    )
    .orderBy(desc(agentSkillRun.startedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    scope: "skill",
    name: r.skillName,
    status: r.outcome,
    errorMessage: r.notes && r.notes.length > 0 ? r.notes.slice(0, 500) : null,
    stepIndex: null,
    workflowRunId: r.workflowRunId ?? null,
    ts: r.startedAt,
  }));
}

// ─────────────────────────── agent ───────────────────────────

async function listAgentFailures(
  sinceIso: string,
  limit: number,
  sessionId: string | undefined
): Promise<FailureRow[]> {
  const db = await getDb();
  /**
   * agent_instance 表没有 createdAt 字段；endedAt 用作失败时间，若 null 则跳过。
   * 这里只取 endedAt >= sinceIso 的 error 实例，避免把历史 error 全拉出来。
   */
  const rows = await db
    .select({
      id: agentInstance.id,
      definitionId: agentInstance.definitionId,
      role: agentDefinition.role,
      name: agentDefinition.name,
      status: agentInstance.status,
      errorMessage: agentInstance.errorMessage,
      endedAt: agentInstance.endedAt,
      workflowRunId: agentInstance.workflowRunId,
      workflowSessionId: workflowRun.sessionId,
    })
    .from(agentInstance)
    .innerJoin(agentDefinition, eq(agentDefinition.id, agentInstance.definitionId))
    .innerJoin(workflowRun, eq(workflowRun.id, agentInstance.workflowRunId))
    .where(
      and(
        eq(agentInstance.status, "error"),
        gte(agentInstance.endedAt, sinceIso),
        sessionId ? eq(workflowRun.sessionId, sessionId) : undefined
      )
    )
    .orderBy(desc(agentInstance.endedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    scope: "agent",
    name: r.role ?? r.name ?? "unknown",
    status: r.status,
    errorMessage: r.errorMessage ?? null,
    stepIndex: null,
    workflowRunId: r.workflowRunId,
    ts: r.endedAt ?? new Date(0).toISOString(),
  }));
}

// ─────────────────────────── util ───────────────────────────

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
