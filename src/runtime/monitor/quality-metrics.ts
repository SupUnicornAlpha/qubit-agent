import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentRuntimeMetric,
  agentSkill,
  agentSkillRun,
  agentStep,
  mcpCallLog,
  sandboxViolationLog,
  toolCallLog,
  workflowQualitySnapshot,
  workflowRun,
} from "../../db/sqlite/schema";

/**
 * Agent 维度下钻拆分（写入 agent_runtime_metric.breakdown_json）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.3。
 *
 * - byTool：内建/ACP 工具调用统计
 * - byMcp ：MCP 服务调用统计（来自 mcp_call_log，含 server.tool 命名）
 * - bySkill：技能执行统计（来自 agent_skill_run）
 * - errorTopN：错误消息 Top N（来自 tool_call_log + mcp_call_log 的 error/timeout 行）
 *
 * 字段为快照型聚合，不保留时间序列；前端基于这份 JSON 直接画下钻面板。
 */
export type AgentMetricBreakdown = {
  byTool: Record<string, { count: number; error: number; avgLatencyMs: number | null }>;
  byMcp: Record<string, { count: number; error: number; avgLatencyMs: number | null }>;
  bySkill: Record<string, { count: number; fail: number }>;
  errorTopN: Array<{ message: string; count: number }>;
};

const ERROR_TOP_N = 5;
/** 错误消息归一化后超过该长度就截断（防止异常堆栈把 JSON 撑爆） */
const ERROR_KEY_MAX = 200;

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function calcQualityScore(input: {
  totalToolCalls: number;
  sandboxBlockCount: number;
  errorCount: number;
}): number {
  const toolPenalty = Math.min(0.4, input.totalToolCalls * 0.005);
  const sandboxPenalty = Math.min(0.3, input.sandboxBlockCount * 0.08);
  const errorPenalty = Math.min(0.6, input.errorCount * 0.12);
  return Math.max(0, Number((1 - toolPenalty - sandboxPenalty - errorPenalty).toFixed(4)));
}

export async function createWorkflowQualitySnapshot(workflowId: string) {
  const db = await getDb();
  const [workflowRows, steps, instances, violations] = await Promise.all([
    db.select().from(workflowRun).where(eq(workflowRun.id, workflowId)).limit(1),
    db.select().from(agentStep).where(eq(agentStep.workflowRunId, workflowId)),
    db.select().from(agentInstance).where(eq(agentInstance.workflowRunId, workflowId)),
    db.select().from(sandboxViolationLog).where(eq(sandboxViolationLog.workflowRunId, workflowId)),
  ]);
  const workflow = workflowRows[0];
  if (!workflow) throw new Error("workflow not found");

  const stepIds = steps.map((s) => s.id);
  const toolCalls =
    stepIds.length > 0
      ? await db.select().from(toolCallLog).where(inArray(toolCallLog.agentStepId, stepIds))
      : [];
  const sandboxBlockCount = toolCalls.filter((t) => t.status === "sandbox_blocked").length;
  const timeoutCount = toolCalls.filter((t) => t.status === "timeout").length;
  const toolErrorCount = toolCalls.filter((t) => t.status === "error").length;
  const instanceErrorCount = instances.filter((i) => i.status === "error").length;
  const errorCount = violations.length + toolErrorCount + timeoutCount + instanceErrorCount;

  const startedAtMs = workflow.startedAt ? Date.parse(workflow.startedAt) : NaN;
  const endedAtMs = workflow.endedAt ? Date.parse(workflow.endedAt) : Date.now();
  const totalDurationMs = Number.isFinite(startedAtMs) ? Math.max(0, endedAtMs - startedAtMs) : null;

  const qualityScore = calcQualityScore({
    totalToolCalls: toolCalls.length,
    sandboxBlockCount,
    errorCount,
  });

  const id = randomUUID();
  await db.insert(workflowQualitySnapshot).values({
    id,
    workflowRunId: workflowId,
    totalDurationMs,
    totalToolCalls: toolCalls.length,
    sandboxBlockCount,
    errorCount,
    qualityScore,
  });
  const row = await db.select().from(workflowQualitySnapshot).where(eq(workflowQualitySnapshot.id, id)).limit(1);
  return row[0];
}

export async function listWorkflowQualitySnapshots(workflowId: string) {
  const db = await getDb();
  return db
    .select()
    .from(workflowQualitySnapshot)
    .where(eq(workflowQualitySnapshot.workflowRunId, workflowId))
    .orderBy(desc(workflowQualitySnapshot.createdAt));
}

/**
 * 聚合 Agent 维度运行时指标（窗口内）并 UPSERT 到 agent_runtime_metric。
 *
 * v2 改动（详见 docs/MONITORING_V2_DESIGN.md §4.1.3）：
 *   - 同时计算 breakdownJson（按工具/MCP/Skill/错误 Top N 拆分），写入新增列
 *   - 同窗口同 definition 不再产生历史副本，使用 UPSERT（依赖迁移 0048 的唯一索引）
 *   - 引入 mcp_call_log 与 agent_skill_run 作为新增数据源（不影响原有 runCount/latency 等聚合口径）
 */
export async function aggregateAgentRuntimeMetrics(input?: {
  windowStart?: string;
  windowEnd?: string;
}) {
  const db = await getDb();
  const now = new Date();
  const windowEnd = input?.windowEnd ?? now.toISOString();
  const windowStart =
    input?.windowStart ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [instances, steps, tools, mcps, skillRuns, skills, definitions] = await Promise.all([
    db
      .select()
      .from(agentInstance)
      .where(and(gte(agentInstance.startedAt, windowStart), lte(agentInstance.startedAt, windowEnd))),
    db
      .select()
      .from(agentStep)
      .where(and(gte(agentStep.createdAt, windowStart), lte(agentStep.createdAt, windowEnd))),
    db
      .select()
      .from(toolCallLog)
      .where(and(gte(toolCallLog.createdAt, windowStart), lte(toolCallLog.createdAt, windowEnd))),
    db
      .select()
      .from(mcpCallLog)
      .where(and(gte(mcpCallLog.createdAt, windowStart), lte(mcpCallLog.createdAt, windowEnd))),
    db
      .select()
      .from(agentSkillRun)
      .where(and(gte(agentSkillRun.startedAt, windowStart), lte(agentSkillRun.startedAt, windowEnd))),
    db.select().from(agentSkill),
    db.select().from(agentDefinition),
  ]);

  const defById = new Map(definitions.map((d) => [d.id, d]));
  const skillById = new Map(skills.map((s) => [s.id, s]));

  const stepsByInstance = new Map<string, typeof steps>();
  for (const step of steps) {
    const bucket = stepsByInstance.get(step.agentInstanceId) ?? [];
    bucket.push(step);
    stepsByInstance.set(step.agentInstanceId, bucket);
  }
  /** stepId → 关联的工具调用（来自 tool_call_log，含 builtin/acp_connector/skill/mcp 四类） */
  const toolsByStep = new Map<string, typeof tools>();
  for (const tool of tools) {
    const bucket = toolsByStep.get(tool.agentStepId) ?? [];
    bucket.push(tool);
    toolsByStep.set(tool.agentStepId, bucket);
  }
  /** stepId → mcp_call_log 行（含 serverName，用于 byMcp 维度命名） */
  const mcpsByStep = new Map<string, typeof mcps>();
  for (const m of mcps) {
    const bucket = mcpsByStep.get(m.agentStepId) ?? [];
    bucket.push(m);
    mcpsByStep.set(m.agentStepId, bucket);
  }
  /** definitionId → 该窗口内的 skill_run（按 agent definition 归属） */
  const skillRunsByDef = new Map<string, typeof skillRuns>();
  for (const sr of skillRuns) {
    if (!sr.definitionId) continue;
    const bucket = skillRunsByDef.get(sr.definitionId) ?? [];
    bucket.push(sr);
    skillRunsByDef.set(sr.definitionId, bucket);
  }

  type Counter = { count: number; error: number; latencies: number[] };
  type DefMetric = {
    runCount: number;
    successCount: number;
    errorCount: number;
    timeoutCount: number;
    latencies: number[];
    tokenSum: number;
    tokenCount: number;
    byTool: Map<string, Counter>;
    byMcp: Map<string, Counter>;
    bySkill: Map<string, { count: number; fail: number }>;
    errorMsgs: Map<string, number>;
  };
  const metricsByDefinition = new Map<string, DefMetric>();
  const getMetric = (key: string): DefMetric => {
    let m = metricsByDefinition.get(key);
    if (!m) {
      m = {
        runCount: 0,
        successCount: 0,
        errorCount: 0,
        timeoutCount: 0,
        latencies: [],
        tokenSum: 0,
        tokenCount: 0,
        byTool: new Map(),
        byMcp: new Map(),
        bySkill: new Map(),
        errorMsgs: new Map(),
      };
      metricsByDefinition.set(key, m);
    }
    return m;
  };

  for (const instance of instances) {
    const m = getMetric(instance.definitionId);
    m.runCount += 1;
    if (instance.status === "error") m.errorCount += 1;
    else if (instance.status === "stopped") m.successCount += 1;
    const instanceSteps = stepsByInstance.get(instance.id) ?? [];
    for (const step of instanceSteps) {
      if (typeof step.tokenCount === "number") {
        m.tokenSum += step.tokenCount;
        m.tokenCount += 1;
      }
      const calls = toolsByStep.get(step.id) ?? [];
      for (const call of calls) {
        if (typeof call.latencyMs === "number") m.latencies.push(call.latencyMs);
        if (call.status === "timeout") m.timeoutCount += 1;
        if (call.status === "error") m.errorCount += 1;
        // byTool 仅纳入 builtin / acp_connector / skill；mcp 用专门的 byMcp 拆分
        if (call.toolKind !== "mcp") {
          accumulateCounter(m.byTool, call.toolName, call);
        }
        if (call.errorMessage && (call.status === "error" || call.status === "timeout")) {
          incrementError(m.errorMsgs, call.errorMessage);
        }
      }
      const mcpCalls = mcpsByStep.get(step.id) ?? [];
      for (const call of mcpCalls) {
        const key = `${call.serverName}.${call.toolName}`;
        accumulateCounter(m.byMcp, key, call);
        if ((call.status === "failed" || call.status === "timeout") && call.errorCode) {
          incrementError(m.errorMsgs, call.errorCode);
        }
      }
    }
    // bySkill 直接按 definitionId 关联（agent_skill_run 已写入 definitionId）
    const runs = skillRunsByDef.get(instance.definitionId) ?? [];
    for (const sr of runs) {
      const skillName = skillById.get(sr.skillId)?.name ?? sr.skillId;
      const cur = m.bySkill.get(skillName) ?? { count: 0, fail: 0 };
      cur.count += 1;
      if (sr.outcome === "fail") cur.fail += 1;
      m.bySkill.set(skillName, cur);
    }
  }

  for (const [definitionId, m] of metricsByDefinition) {
    const breakdown: AgentMetricBreakdown = {
      byTool: counterMapToObject(m.byTool),
      byMcp: counterMapToObject(m.byMcp),
      bySkill: Object.fromEntries(m.bySkill),
      errorTopN: topNErrors(m.errorMsgs, ERROR_TOP_N),
    };
    const values = {
      id: randomUUID(),
      definitionId,
      windowStart,
      windowEnd,
      runCount: m.runCount,
      successCount: m.successCount,
      errorCount: m.errorCount,
      timeoutCount: m.timeoutCount,
      p50LatencyMs: percentile(m.latencies, 50),
      p95LatencyMs: percentile(m.latencies, 95),
      avgTokenCount: m.tokenCount > 0 ? Number((m.tokenSum / m.tokenCount).toFixed(2)) : null,
      breakdownJson: breakdown as unknown as Record<string, unknown>,
    };
    // 依赖 0048 迁移建立的唯一索引 (definition_id, window_start, window_end)
    await db
      .insert(agentRuntimeMetric)
      .values(values)
      .onConflictDoUpdate({
        target: [
          agentRuntimeMetric.definitionId,
          agentRuntimeMetric.windowStart,
          agentRuntimeMetric.windowEnd,
        ],
        set: {
          runCount: values.runCount,
          successCount: values.successCount,
          errorCount: values.errorCount,
          timeoutCount: values.timeoutCount,
          p50LatencyMs: values.p50LatencyMs,
          p95LatencyMs: values.p95LatencyMs,
          avgTokenCount: values.avgTokenCount,
          breakdownJson: values.breakdownJson,
        },
      });
  }

  const rows = metricsByDefinition.size
    ? await db
        .select()
        .from(agentRuntimeMetric)
        .where(and(gte(agentRuntimeMetric.windowStart, windowStart), lte(agentRuntimeMetric.windowEnd, windowEnd)))
        .orderBy(desc(agentRuntimeMetric.createdAt))
    : [];
  return rows.map((row) => ({
    ...row,
    role: defById.get(row.definitionId)?.role ?? "unknown",
    name: defById.get(row.definitionId)?.name ?? "unknown",
  }));
}

/**
 * 累加单次工具/MCP 调用到 (count / error / latencies) 桶。
 * 导出仅供 quality-metrics.test.ts；线上路径不应直接消费。
 */
export function accumulateCounter(
  bucket: Map<string, { count: number; error: number; latencies: number[] }>,
  key: string,
  call: { status: string; latencyMs: number | null }
): void {
  const cur = bucket.get(key) ?? { count: 0, error: 0, latencies: [] };
  cur.count += 1;
  if (call.status === "error" || call.status === "timeout" || call.status === "failed") {
    cur.error += 1;
  }
  if (typeof call.latencyMs === "number") cur.latencies.push(call.latencyMs);
  bucket.set(key, cur);
}

/** 把内部 Map 桶转成 breakdownJson 里平铺的 object。导出仅供测试。 */
export function counterMapToObject(
  bucket: Map<string, { count: number; error: number; latencies: number[] }>
): Record<string, { count: number; error: number; avgLatencyMs: number | null }> {
  const out: Record<string, { count: number; error: number; avgLatencyMs: number | null }> = {};
  for (const [k, v] of bucket) {
    const avg = v.latencies.length
      ? Number((v.latencies.reduce((a, b) => a + b, 0) / v.latencies.length).toFixed(2))
      : null;
    out[k] = { count: v.count, error: v.error, avgLatencyMs: avg };
  }
  return out;
}

function incrementError(bucket: Map<string, number>, message: string): void {
  const key = message.trim().slice(0, ERROR_KEY_MAX);
  if (!key) return;
  bucket.set(key, (bucket.get(key) ?? 0) + 1);
}

/** 按 count 降序取 Top N 错误消息。导出仅供测试。 */
export function topNErrors(
  bucket: Map<string, number>,
  n: number
): Array<{ message: string; count: number }> {
  return [...bucket.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([message, count]) => ({ message, count }));
}

/** 公共 helper：测试 / 兼容旧 DB 行用。 */
export function parseBreakdownJson(raw: unknown): AgentMetricBreakdown {
  return parseBreakdown(raw);
}

/**
 * Agent 维度下钻详情：用于前端「点击 Agent 卡片 → 展开 byTool/byMcp/bySkill/errorTopN」。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.3 / §5.3。
 *
 * 返回最近 N 小时（默认 24h）窗口内的：
 *   - definition（角色名 / 版本）
 *   - 该窗口的 agent_runtime_metric 行（包含解析后的 breakdown）
 *   - 该 definition 名下最近 10 个 instance（用于跳详情）
 *   - failedInstances：window 内 status='error' 的 instances（含 errorMessage）
 */
export async function getAgentRuntimeDetail(
  definitionId: string,
  input?: { windowStart?: string; windowEnd?: string }
) {
  const db = await getDb();
  const now = new Date();
  const windowEnd = input?.windowEnd ?? now.toISOString();
  const windowStart =
    input?.windowStart ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [defRows, metricRows, recentInstances] = await Promise.all([
    db.select().from(agentDefinition).where(eq(agentDefinition.id, definitionId)).limit(1),
    db
      .select()
      .from(agentRuntimeMetric)
      .where(
        and(
          eq(agentRuntimeMetric.definitionId, definitionId),
          gte(agentRuntimeMetric.windowStart, windowStart),
          lte(agentRuntimeMetric.windowEnd, windowEnd)
        )
      )
      .orderBy(desc(agentRuntimeMetric.createdAt))
      .limit(1),
    db
      .select()
      .from(agentInstance)
      .where(
        and(
          eq(agentInstance.definitionId, definitionId),
          gte(agentInstance.startedAt, windowStart)
        )
      )
      .orderBy(desc(agentInstance.startedAt))
      .limit(10),
  ]);

  const definition = defRows[0] ?? null;
  const metric = metricRows[0] ?? null;
  let breakdown: AgentMetricBreakdown | null = null;
  if (metric?.breakdownJson) {
    breakdown = parseBreakdown(metric.breakdownJson);
  }
  const failedInstances = recentInstances.filter((i) => i.status === "error");

  return {
    definition,
    window: { windowStart, windowEnd },
    metric,
    breakdown,
    recentInstances,
    failedInstances,
  };
}

/** 解析 breakdown JSON；旧行 / 异常输入降级为空骨架 */
function parseBreakdown(raw: unknown): AgentMetricBreakdown {
  const empty: AgentMetricBreakdown = { byTool: {}, byMcp: {}, bySkill: {}, errorTopN: [] };
  if (!raw) return empty;
  // drizzle `mode: 'json'` 自动 parse 为对象；保险起见兼容 string
  const obj = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!obj || typeof obj !== "object") return empty;
  const o = obj as Record<string, unknown>;
  return {
    byTool: (o.byTool as AgentMetricBreakdown["byTool"]) ?? {},
    byMcp: (o.byMcp as AgentMetricBreakdown["byMcp"]) ?? {},
    bySkill: (o.bySkill as AgentMetricBreakdown["bySkill"]) ?? {},
    errorTopN: Array.isArray(o.errorTopN) ? (o.errorTopN as AgentMetricBreakdown["errorTopN"]) : [],
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function listAgentRuntimeMetrics(input?: {
  windowStart?: string;
  windowEnd?: string;
}) {
  const db = await getDb();
  const now = new Date();
  const windowEnd = input?.windowEnd ?? now.toISOString();
  const windowStart =
    input?.windowStart ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const definitions = await db.select().from(agentDefinition);
  const defById = new Map(definitions.map((d) => [d.id, d]));
  const rows = await db
    .select()
    .from(agentRuntimeMetric)
    .where(and(gte(agentRuntimeMetric.windowStart, windowStart), lte(agentRuntimeMetric.windowEnd, windowEnd)))
    .orderBy(desc(agentRuntimeMetric.createdAt));
  return rows.map((row) => ({
    ...row,
    role: defById.get(row.definitionId)?.role ?? "unknown",
    name: defById.get(row.definitionId)?.name ?? "unknown",
  }));
}
