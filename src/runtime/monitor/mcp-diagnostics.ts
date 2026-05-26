/**
 * 监控 · 单一 MCP server 排障详情服务。
 *
 * 与 `tools-diagnostics.ts` 同思路，但聚焦 mcp_call_log + mcp_server_health：
 *   - summary：复用 mcp-summary 的单条结构 + 持久化熔断状态
 *   - recentCalls：最近 N 条调用流水
 *   - errorTop：错误消息聚合（mcp_call_log 没有专门 errorMessage 字段，
 *               但 errorCode + responseJson 里通常有细节；这里以 errorCode 为主聚合）
 *   - byTool：当前 server 下每个 mcp tool 的调用情况
 *
 * 复用 `tools-diagnostics.ts` 的 `normalizeErrorMessage` / `percentile` 工具。
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpCallLog, mcpServerHealth, workflowRun } from "../../db/sqlite/schema";
import { normalizeErrorMessage } from "./tools-diagnostics";

export type McpStatus = "success" | "timeout" | "failed" | "sandbox_blocked";

export type McpDiagnosticsCall = {
  id: string;
  toolName: string;
  status: McpStatus;
  errorCode: string | null;
  latencyMs: number | null;
  retryCount: number;
  workflowRunId: string;
  agentStepId: string;
  createdAt: string;
};

export type McpErrorTopRow = {
  errorCode: string;
  /** 该 errorCode 的最近一次 message（如果可拿） */
  sampleMessage: string | null;
  count: number;
  lastSeenAt: string;
  sampleWorkflowRunId: string | null;
};

export type McpHealthSnapshot = {
  circuitState: "closed" | "open" | "half_open";
  failureCount: number;
  successCount: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  openedAt: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
  cooldownMs: number;
};

export type McpByToolStat = {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failedCount: number;
  timeoutCount: number;
  sandboxBlockedCount: number;
  avgLatencyMs: number | null;
};

export type McpDiagnosticsResult = {
  serverName: string;
  windowMinutes: number;
  /** 当前窗口聚合 */
  summary: {
    totalCalls: number;
    successCount: number;
    failedCount: number;
    timeoutCount: number;
    sandboxBlockedCount: number;
    successRate: number;
    avgLatencyMs: number | null;
    lastCalledAt: string | null;
  };
  /** 持久化的熔断状态；如果该 server 还没有任何 mcp_server_health 行返回 null */
  health: McpHealthSnapshot | null;
  latency: { p50: number | null; p95: number | null; p99: number | null; samples: number };
  recentCalls: McpDiagnosticsCall[];
  errorTop: McpErrorTopRow[];
  /** 该 server 下所有调用过的 tool 列表的失败分布 */
  byTool: McpByToolStat[];
};

export async function getMcpDiagnostics(input: {
  serverName: string;
  windowMinutes?: number;
  recentLimit?: number;
  errorTopLimit?: number;
  sessionId?: string;
}): Promise<McpDiagnosticsResult> {
  const db = await getDb();
  const windowMinutes = clampInt(input.windowMinutes ?? 24 * 60, 1, 7 * 24 * 60);
  const recentLimit = clampInt(input.recentLimit ?? 50, 1, 200);
  const errorTopLimit = clampInt(input.errorTopLimit ?? 10, 1, 50);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const conditions = [
    gte(mcpCallLog.createdAt, sinceIso),
    eq(mcpCallLog.serverName, input.serverName),
  ];
  if (input.sessionId) conditions.push(eq(workflowRun.sessionId, input.sessionId));

  const rows = await db
    .select({
      id: mcpCallLog.id,
      toolName: mcpCallLog.toolName,
      status: mcpCallLog.status,
      errorCode: mcpCallLog.errorCode,
      latencyMs: mcpCallLog.latencyMs,
      retryCount: mcpCallLog.retryCount,
      workflowRunId: mcpCallLog.workflowRunId,
      agentStepId: mcpCallLog.agentStepId,
      responseJson: mcpCallLog.responseJson,
      createdAt: mcpCallLog.createdAt,
    })
    .from(mcpCallLog)
    .leftJoin(workflowRun, eq(workflowRun.id, mcpCallLog.workflowRunId))
    .where(and(...conditions))
    .orderBy(desc(mcpCallLog.createdAt));

  const summary = aggregateSummary(rows);
  const latency = computeLatencyPercentiles(rows);
  const recentCalls: McpDiagnosticsCall[] = rows.slice(0, recentLimit).map((r) => ({
    id: r.id,
    toolName: r.toolName,
    status: r.status as McpStatus,
    errorCode: r.errorCode ?? null,
    latencyMs: r.latencyMs ?? null,
    retryCount: r.retryCount ?? 0,
    workflowRunId: r.workflowRunId,
    agentStepId: r.agentStepId,
    createdAt: r.createdAt,
  }));
  const errorTop = aggregateErrorTop(rows, errorTopLimit);
  const byTool = aggregateByTool(rows);

  // 健康表（最新一行；schema 上是 unique(serverName)）
  const hRows = await db
    .select()
    .from(mcpServerHealth)
    .where(eq(mcpServerHealth.serverName, input.serverName))
    .limit(1);
  const h = hRows[0];
  const health: McpHealthSnapshot | null = h
    ? {
        circuitState: h.circuitState,
        failureCount: h.failureCount,
        successCount: h.successCount,
        lastFailureAt: h.lastFailureAt ?? null,
        lastSuccessAt: h.lastSuccessAt ?? null,
        openedAt: h.openedAt ?? null,
        lastErrorMessage: h.lastErrorMessage ?? null,
        updatedAt: h.updatedAt,
        cooldownMs: h.cooldownMs,
      }
    : null;

  return {
    serverName: input.serverName,
    windowMinutes,
    summary,
    health,
    latency,
    recentCalls,
    errorTop,
    byTool,
  };
}

// ───────────────────────── 纯函数 helpers (单测覆盖) ─────────────────────────

type RawMcpRow = {
  status: string;
  toolName: string;
  errorCode: string | null;
  latencyMs: number | null;
  workflowRunId: string;
  createdAt: string;
  responseJson: unknown;
};

export function aggregateSummary(rows: RawMcpRow[]): McpDiagnosticsResult["summary"] {
  let success = 0;
  let failed = 0;
  let timeout = 0;
  let sandbox = 0;
  let latSum = 0;
  let latCount = 0;
  let lastCalledAt: string | null = null;
  for (const r of rows) {
    if (r.status === "success") success += 1;
    else if (r.status === "timeout") timeout += 1;
    else if (r.status === "sandbox_blocked") sandbox += 1;
    else failed += 1;
    if (typeof r.latencyMs === "number") {
      latSum += r.latencyMs;
      latCount += 1;
    }
    if (!lastCalledAt || r.createdAt > lastCalledAt) lastCalledAt = r.createdAt;
  }
  const total = rows.length;
  return {
    totalCalls: total,
    successCount: success,
    failedCount: failed,
    timeoutCount: timeout,
    sandboxBlockedCount: sandbox,
    successRate: total > 0 ? Number((success / total).toFixed(4)) : 0,
    avgLatencyMs: latCount > 0 ? Number((latSum / latCount).toFixed(2)) : null,
    lastCalledAt,
  };
}

export function computeLatencyPercentiles(rows: RawMcpRow[]): {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  samples: number;
} {
  const lat = rows
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
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return Number((sorted[lo]! * (1 - frac) + sorted[hi]! * frac).toFixed(2));
}

export function aggregateErrorTop(rows: RawMcpRow[], limit: number): McpErrorTopRow[] {
  /**
   * MCP 错误聚合按 errorCode 主键；同一 errorCode 下取最近一次的 responseJson 摘要做 sampleMessage。
   * - errorCode 为 null 时，以 status（'failed' / 'timeout' / 'sandbox_blocked'）作为兜底 key
   */
  const map = new Map<
    string,
    { count: number; lastSeenAt: string; sampleWorkflowRunId: string | null; sampleMessage: string | null }
  >();
  for (const r of rows) {
    if (r.status === "success") continue;
    const key = r.errorCode ?? `(${r.status})`;
    let cur = map.get(key);
    if (!cur) {
      cur = {
        count: 0,
        lastSeenAt: r.createdAt,
        sampleWorkflowRunId: r.workflowRunId,
        sampleMessage: extractErrorMessageFromResponse(r.responseJson),
      };
      map.set(key, cur);
    }
    cur.count += 1;
    if (r.createdAt > cur.lastSeenAt) {
      cur.lastSeenAt = r.createdAt;
      cur.sampleWorkflowRunId = r.workflowRunId;
      const msg = extractErrorMessageFromResponse(r.responseJson);
      if (msg) cur.sampleMessage = msg;
    }
  }
  return [...map.entries()]
    .map(([errorCode, v]) => ({ errorCode, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * 从 mcp_call_log.responseJson 提取错误消息：
 *   - 优先取 .error.message / .message / .error / .detail（按这个优先级，匹配常见 MCP 错误结构）
 *   - 兜底走 JSON.stringify 头 240 字
 *   - 跑一次 normalizeErrorMessage（UUID/时间戳 mask）
 */
export function extractErrorMessageFromResponse(resp: unknown): string | null {
  if (!resp) return null;
  if (typeof resp === "string") return normalizeErrorMessage(resp);
  if (typeof resp !== "object") return null;
  const r = resp as Record<string, unknown>;
  const errObj = r["error"];
  let candidate: unknown = null;
  if (errObj && typeof errObj === "object") {
    candidate = (errObj as Record<string, unknown>)["message"];
  }
  if (!candidate) candidate = r["message"];
  if (!candidate) candidate = errObj;
  if (!candidate) candidate = r["detail"];
  if (typeof candidate === "string") return normalizeErrorMessage(candidate);
  if (candidate != null) {
    try {
      return normalizeErrorMessage(JSON.stringify(candidate));
    } catch {
      return null;
    }
  }
  return null;
}

export function aggregateByTool(rows: RawMcpRow[]): McpByToolStat[] {
  const map = new Map<
    string,
    {
      totalCalls: number;
      successCount: number;
      failedCount: number;
      timeoutCount: number;
      sandboxBlockedCount: number;
      latSum: number;
      latCount: number;
    }
  >();
  for (const r of rows) {
    let cur = map.get(r.toolName);
    if (!cur) {
      cur = {
        totalCalls: 0,
        successCount: 0,
        failedCount: 0,
        timeoutCount: 0,
        sandboxBlockedCount: 0,
        latSum: 0,
        latCount: 0,
      };
      map.set(r.toolName, cur);
    }
    cur.totalCalls += 1;
    if (r.status === "success") cur.successCount += 1;
    else if (r.status === "timeout") cur.timeoutCount += 1;
    else if (r.status === "sandbox_blocked") cur.sandboxBlockedCount += 1;
    else cur.failedCount += 1;
    if (typeof r.latencyMs === "number") {
      cur.latSum += r.latencyMs;
      cur.latCount += 1;
    }
  }
  return [...map.entries()]
    .map(([toolName, v]) => ({
      toolName,
      totalCalls: v.totalCalls,
      successCount: v.successCount,
      failedCount: v.failedCount,
      timeoutCount: v.timeoutCount,
      sandboxBlockedCount: v.sandboxBlockedCount,
      avgLatencyMs: v.latCount > 0 ? Number((v.latSum / v.latCount).toFixed(2)) : null,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
