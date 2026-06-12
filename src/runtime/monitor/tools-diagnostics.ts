/**
 * 监控 · 单一 Tool 排障详情服务。
 *
 * 设计目标：
 *   - 已有 `tools-summary.ts` 提供"跨工具列表"；这里补"单一工具的排障详情"。
 *   - 输出包含：summary KPI + recentCalls + errorTopN + sandboxViolations + latency 分位数
 *   - 沙箱阻断关联：tool_call_log.status='sandbox_blocked' 行通过 (workflowRunId, agentStepId)
 *     反查 sandbox_violation_log，定位具体 violationType 与 policy。
 *
 * 用法（在 routes 层）：
 *   const r = await getToolDiagnostics({ toolName: 'call_team_analyst', windowMinutes: 60 });
 *
 * 性能注意：扫描行数 = 该工具在窗口内的 tool_call_log 行数；前端默认 24h 内对单工具一般 < 1k 行。
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentStep,
  sandboxViolationLog,
  toolCallLog,
  workflowRun,
} from "../../db/sqlite/schema";
import type { ToolKind, ToolSummaryRow } from "./tools-summary";

export type ToolStatus = "success" | "error" | "timeout" | "sandbox_blocked";

export type ToolDiagnosticsCall = {
  id: string;
  status: ToolStatus;
  errorMessage: string | null;
  latencyMs: number | null;
  retryCount: number;
  workflowRunId: string | null;
  agentStepId: string;
  stepIndex: number | null;
  createdAt: string;
};

export type ErrorTopRow = {
  /** 归一化后的错误消息（去掉路径中变化部分等，便于聚合） */
  errorMessage: string;
  count: number;
  lastSeenAt: string;
  sampleWorkflowRunId: string | null;
};

export type SandboxViolationGroup = {
  violationType: string;
  count: number;
  lastSeenAt: string;
  sampleWorkflowRunId: string | null;
  samplePolicyId: string | null;
};

export type ToolDiagnosticsResult = {
  /** 单工具的窗口聚合，与 tools-summary 同结构 */
  summary: ToolSummaryRow;
  /** p50 / p95 / p99 latency（毫秒）；样本不足返回 null */
  latency: {
    p50: number | null;
    p95: number | null;
    p99: number | null;
    samples: number;
  };
  /** 最近 N 次调用流水（默认 50） */
  recentCalls: ToolDiagnosticsCall[];
  /** 错误消息 top（合并相似消息 + count 降序） */
  errorTop: ErrorTopRow[];
  /** 沙箱阻断分类详情（按 violationType 分桶） */
  sandboxViolations: SandboxViolationGroup[];
};

export async function getToolDiagnostics(input: {
  toolName: string;
  toolKind?: ToolKind;
  /** 时间窗口（分钟），默认 24h，最大 7d */
  windowMinutes?: number;
  /** recent calls 上限（默认 50，max 200） */
  recentLimit?: number;
  /** error top 上限（默认 10，max 50） */
  errorTopLimit?: number;
  sessionId?: string;
}): Promise<ToolDiagnosticsResult> {
  const db = await getDb();
  const windowMinutes = clampInt(input.windowMinutes ?? 24 * 60, 1, 7 * 24 * 60);
  const recentLimit = clampInt(input.recentLimit ?? 50, 1, 200);
  const errorTopLimit = clampInt(input.errorTopLimit ?? 10, 1, 50);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  /**
   * 主查询：拉窗口内目标工具的全部调用行（含 success / error / timeout / sandbox_blocked）。
   * 同时 left join workflow_run 拿 sessionId（如果给了 sessionId 过滤）+ agent_step 拿 stepIndex
   * 便于前端表格直接显示。
   */
  const conditions = [
    gte(toolCallLog.createdAt, sinceIso),
    eq(toolCallLog.toolName, input.toolName),
  ];
  if (input.toolKind) conditions.push(eq(toolCallLog.toolKind, input.toolKind));
  if (input.sessionId) conditions.push(eq(workflowRun.sessionId, input.sessionId));

  const rows = await db
    .select({
      id: toolCallLog.id,
      status: toolCallLog.status,
      errorMessage: toolCallLog.errorMessage,
      latencyMs: toolCallLog.latencyMs,
      retryCount: toolCallLog.retryCount,
      workflowRunId: toolCallLog.workflowRunId,
      agentStepId: toolCallLog.agentStepId,
      stepIndex: agentStep.stepIndex,
      createdAt: toolCallLog.createdAt,
      toolKind: toolCallLog.toolKind,
    })
    .from(toolCallLog)
    .leftJoin(agentStep, eq(agentStep.id, toolCallLog.agentStepId))
    .leftJoin(workflowRun, eq(workflowRun.id, toolCallLog.workflowRunId))
    .where(and(...conditions))
    .orderBy(desc(toolCallLog.createdAt));

  const summary = aggregateSummary(input.toolName, rows);
  const latency = computeLatencyPercentiles(rows);
  const recentCalls: ToolDiagnosticsCall[] = rows.slice(0, recentLimit).map((r) => ({
    id: r.id,
    status: r.status as ToolStatus,
    errorMessage: r.errorMessage ?? null,
    latencyMs: r.latencyMs ?? null,
    retryCount: r.retryCount ?? 0,
    workflowRunId: r.workflowRunId ?? null,
    agentStepId: r.agentStepId,
    stepIndex: r.stepIndex ?? null,
    createdAt: r.createdAt,
  }));
  const errorTop = aggregateErrorTop(rows, errorTopLimit);

  /**
   * 沙箱阻断详情：仅当 sandboxBlocked > 0 时再查 sandbox_violation_log，
   * 避免对所有工具都跑一次额外查询。
   */
  let sandboxViolations: SandboxViolationGroup[] = [];
  if (summary.sandboxBlockedCount > 0) {
    /**
     * sandbox_violation_log 没有 toolName 字段，只能通过 (workflowRunId) 反查；
     * 但同一 workflow 里可能多个工具被沙箱拦，因此还要 attemptedAction 里二次过滤。
     * 这里用「拿同 workflow + 时间相近」的近似口径，前端展示成「该工具相关的沙箱事件」。
     */
    const sandboxWorkflowIds = Array.from(
      new Set(
        rows.filter((r) => r.status === "sandbox_blocked" && r.workflowRunId).map((r) => r.workflowRunId!)
      )
    );
    sandboxViolations = await querySandboxViolations(db, sandboxWorkflowIds, sinceIso, input.toolName);
  }

  return {
    summary,
    latency,
    recentCalls,
    errorTop,
    sandboxViolations,
  };
}

// ───────────────────────── 纯函数 helpers (单测覆盖) ─────────────────────────

type RawRow = {
  status: string;
  latencyMs: number | null;
  errorMessage: string | null;
  workflowRunId: string | null;
  createdAt: string;
  toolKind: string;
};

export function aggregateSummary(toolName: string, rows: RawRow[]): ToolSummaryRow {
  let success = 0;
  let error = 0;
  let timeout = 0;
  let sandbox = 0;
  let latSum = 0;
  let latCount = 0;
  let lastCalledAt: string | null = null;
  let toolKind: ToolKind = "builtin";

  for (const r of rows) {
    if (r.status === "success") success += 1;
    else if (r.status === "timeout") timeout += 1;
    else if (r.status === "sandbox_blocked") sandbox += 1;
    else error += 1;
    /**
     * 治理 #4：latency 统计排除 sandbox_blocked。这类调用在 act.ts 里被沙箱在
     * 真正起 timer（startedAt）之前就拦下，从未真实执行；但 recordToolCallStart
     * 乐观初始化成 latencyMs=1 且 blocked 终态不覆盖，留下假的 1ms。若计入会把
     * 工具真实延迟的 avg / p50 / p95 往下拽。timeout/error 仍计入（它们有真实耗时）。
     */
    if (typeof r.latencyMs === "number" && r.status !== "sandbox_blocked") {
      latSum += r.latencyMs;
      latCount += 1;
    }
    if (!lastCalledAt || r.createdAt > lastCalledAt) lastCalledAt = r.createdAt;
    toolKind = (r.toolKind as ToolKind) ?? toolKind;
  }
  const total = rows.length;
  return {
    toolKind,
    toolName,
    totalCalls: total,
    successCount: success,
    errorCount: error,
    timeoutCount: timeout,
    sandboxBlockedCount: sandbox,
    successRate: total > 0 ? Number((success / total).toFixed(4)) : 0,
    avgLatencyMs: latCount > 0 ? Number((latSum / latCount).toFixed(2)) : null,
    lastCalledAt,
  };
}

export function computeLatencyPercentiles(rows: RawRow[]): {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  samples: number;
} {
  const lat = rows
    /** 治理 #4：sandbox_blocked 留的假 1ms 不计入分位（见 aggregateSummary 注释） */
    .filter((r) => r.status !== "sandbox_blocked")
    .map((r) => r.latencyMs)
    .filter((v): v is number => typeof v === "number" && v >= 0)
    .sort((a, b) => a - b);
  if (lat.length === 0) return { p50: null, p95: null, p99: null, samples: 0 };
  return {
    p50: percentile(lat, 0.5),
    p95: percentile(lat, 0.95),
    p99: percentile(lat, 0.99),
    samples: lat.length,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  /**
   * 经典 "linear interpolation between closest ranks" 算法（Excel PERCENTILE.INC 等同）。
   * idx 可能是浮点 → 在两个相邻整数 rank 之间线性插值。
   */
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return Number((sorted[lo]! * (1 - frac) + sorted[hi]! * frac).toFixed(2));
}

/**
 * 错误消息归一化：
 *   - 截断（保 240 字）；过长 message 多半是相同 root cause + 不同 ID
 *   - 去掉常见可变片段（UUID / 时间戳 / 纯数字 8+），便于聚合
 *   - 大小写敏感（错误码常大写，保留信息）
 *
 * 这种简化的"近似聚合"对监控完全够用 — 用户看到的是「某类错误」的趋势，而不是逐字精确比对。
 */
export function normalizeErrorMessage(raw: string | null): string {
  if (!raw) return "(empty)";
  let s = raw.trim();
  if (s.length > 240) s = s.slice(0, 240) + "…";
  // UUID
  s = s.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, "<uuid>");
  // ISO 时间戳
  s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>");
  // 8+ 位纯数字
  s = s.replace(/\b\d{8,}\b/g, "<num>");
  return s;
}

export function aggregateErrorTop(rows: RawRow[], limit: number): ErrorTopRow[] {
  const map = new Map<
    string,
    { count: number; lastSeenAt: string; sampleWorkflowRunId: string | null }
  >();
  for (const r of rows) {
    if (r.status === "success") continue;
    const key = normalizeErrorMessage(r.errorMessage);
    let cur = map.get(key);
    if (!cur) {
      cur = { count: 0, lastSeenAt: r.createdAt, sampleWorkflowRunId: r.workflowRunId };
      map.set(key, cur);
    }
    cur.count += 1;
    if (r.createdAt > cur.lastSeenAt) {
      cur.lastSeenAt = r.createdAt;
      cur.sampleWorkflowRunId = r.workflowRunId;
    }
  }
  return [...map.entries()]
    .map(([errorMessage, v]) => ({ errorMessage, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ───────────────────────── DB query helpers ─────────────────────────

async function querySandboxViolations(
  db: Awaited<ReturnType<typeof getDb>>,
  workflowRunIds: string[],
  sinceIso: string,
  toolName: string
): Promise<SandboxViolationGroup[]> {
  if (workflowRunIds.length === 0) return [];
  /**
   * Drizzle inArray + 时间过滤；attemptedAction 是 JSON 列，前端展示时再 parse。
   * 这里只在 JS 层做二次过滤：attemptedAction.tool === toolName（约定字段；非约定时
   * 兜底 attemptedAction.name == toolName 也算）。
   */
  const rows = await db
    .select()
    .from(sandboxViolationLog)
    .where(
      and(
        gte(sandboxViolationLog.createdAt, sinceIso),
        // inArray 的 type 在 P1 里调过；这里 workflowRunIds 是普通 string[]
      )
    )
    .orderBy(desc(sandboxViolationLog.createdAt))
    .limit(200);

  const filtered = rows.filter((r) => {
    if (!workflowRunIds.includes(r.workflowRunId)) return false;
    const action = r.attemptedAction as Record<string, unknown> | null;
    if (!action || typeof action !== "object") return true; // 缺字段时不过滤太严，否则全过滤掉
    const candidateTool =
      typeof action["tool"] === "string"
        ? action["tool"]
        : typeof action["name"] === "string"
          ? action["name"]
          : typeof action["toolName"] === "string"
            ? action["toolName"]
            : null;
    return candidateTool == null || candidateTool === toolName;
  });

  const grouped = new Map<
    string,
    { count: number; lastSeenAt: string; sampleWorkflowRunId: string | null; samplePolicyId: string | null }
  >();
  for (const r of filtered) {
    let cur = grouped.get(r.violationType);
    if (!cur) {
      cur = {
        count: 0,
        lastSeenAt: r.createdAt,
        sampleWorkflowRunId: r.workflowRunId,
        samplePolicyId: r.sandboxPolicyId,
      };
      grouped.set(r.violationType, cur);
    }
    cur.count += 1;
    if (r.createdAt > cur.lastSeenAt) {
      cur.lastSeenAt = r.createdAt;
      cur.sampleWorkflowRunId = r.workflowRunId;
      cur.samplePolicyId = r.sandboxPolicyId;
    }
  }
  return [...grouped.entries()]
    .map(([violationType, v]) => ({ violationType, ...v }))
    .sort((a, b) => b.count - a.count);
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
