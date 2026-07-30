/**
 * 监控 · MCP 维度聚合（跨工作流，时间窗口内）。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §4.1.3 / §6.7）：
 *   - 数据源：mcp_call_log（每次 mcp 工具调用一行） + mcp_server_health（熔断态）
 *   - 输出：按 server_name 聚合的调用数 / 成功 / 失败 / latency；同时附 health 行
 *   - 让前端能一眼看出「某 server 在 24h 内调用 100 次，成功 80，熔断 2 次」
 */
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpCallLog, mcpServerHealth, workflowRun } from "../../db/sqlite/schema";

export type McpSummaryRow = {
  serverName: string;
  totalCalls: number;
  successCount: number;
  fallbackCount: number;
  nativeSuccessCount: number;
  failedCount: number;
  timeoutCount: number;
  sandboxBlockedCount: number;
  successRate: number;
  nativeSuccessRate: number;
  avgLatencyMs: number | null;
  /** 来自 mcp_server_health，可能为 null（启动后该 server 还没调用过） */
  health: {
    circuitState: "closed" | "open" | "half_open";
    failureCount: number;
    successCount: number;
    lastFailureAt: string | null;
    lastSuccessAt: string | null;
    openedAt: string | null;
    lastErrorMessage: string | null;
    updatedAt: string;
  } | null;
  /** 调用层面分 tool 的 top 10（按调用量排序） */
  byTool: Array<{
    toolName: string;
    totalCalls: number;
    successCount: number;
    fallbackCount: number;
    failedCount: number;
  }>;
  lastCalledAt: string | null;
};

export async function getMcpSummary(input?: {
  windowMinutes?: number;
  sessionId?: string;
}): Promise<McpSummaryRow[]> {
  const db = await getDb();
  const windowMinutes = clampInt(input?.windowMinutes ?? 24 * 60, 1, 7 * 24 * 60);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const sessionId = input?.sessionId;

  const callRows = await db
    .select({
      serverName: mcpCallLog.serverName,
      toolName: mcpCallLog.toolName,
      status: mcpCallLog.status,
      responseJson: mcpCallLog.responseJson,
      latencyMs: mcpCallLog.latencyMs,
      createdAt: mcpCallLog.createdAt,
      sessionId: workflowRun.sessionId,
    })
    .from(mcpCallLog)
    .leftJoin(workflowRun, eq(workflowRun.id, mcpCallLog.workflowRunId))
    .where(
      and(
        gte(mcpCallLog.createdAt, sinceIso),
        sessionId ? eq(workflowRun.sessionId, sessionId) : undefined
      )
    );

  const healthRows = await db.select().from(mcpServerHealth);
  const healthByServer = new Map(healthRows.map((row) => [row.serverName, row]));

  type Acc = Omit<
    McpSummaryRow,
    "successRate" | "nativeSuccessRate" | "avgLatencyMs" | "health" | "byTool"
  > & {
    latSum: number;
    latCount: number;
    byToolMap: Map<
      string,
      {
        toolName: string;
        totalCalls: number;
        successCount: number;
        fallbackCount: number;
        failedCount: number;
      }
    >;
  };
  const grouped = new Map<string, Acc>();
  for (const r of callRows) {
    let acc = grouped.get(r.serverName);
    if (!acc) {
      acc = {
        serverName: r.serverName,
        totalCalls: 0,
        successCount: 0,
        fallbackCount: 0,
        nativeSuccessCount: 0,
        failedCount: 0,
        timeoutCount: 0,
        sandboxBlockedCount: 0,
        lastCalledAt: null,
        latSum: 0,
        latCount: 0,
        byToolMap: new Map(),
      };
      grouped.set(r.serverName, acc);
    }
    acc.totalCalls += 1;
    const fallback = isMcpFallbackResponse(r.responseJson);
    if (r.status === "success") {
      acc.successCount += 1;
      if (fallback) acc.fallbackCount += 1;
      else acc.nativeSuccessCount += 1;
    } else if (r.status === "timeout") acc.timeoutCount += 1;
    else if (r.status === "sandbox_blocked") acc.sandboxBlockedCount += 1;
    else if (r.status !== "running") acc.failedCount += 1;
    if (typeof r.latencyMs === "number") {
      acc.latSum += r.latencyMs;
      acc.latCount += 1;
    }
    if (!acc.lastCalledAt || r.createdAt > acc.lastCalledAt) acc.lastCalledAt = r.createdAt;

    const tool = acc.byToolMap.get(r.toolName) ?? {
      toolName: r.toolName,
      totalCalls: 0,
      successCount: 0,
      fallbackCount: 0,
      failedCount: 0,
    };
    tool.totalCalls += 1;
    if (r.status === "success") {
      tool.successCount += 1;
      if (fallback) tool.fallbackCount += 1;
    } else if (r.status !== "running") tool.failedCount += 1;
    acc.byToolMap.set(r.toolName, tool);
  }

  // 即便 0 调用，也要把 health 行展示出来（前端可看到「某 server 熔断中」）
  for (const h of healthRows) {
    if (!grouped.has(h.serverName)) {
      grouped.set(h.serverName, {
        serverName: h.serverName,
        totalCalls: 0,
        successCount: 0,
        fallbackCount: 0,
        nativeSuccessCount: 0,
        failedCount: 0,
        timeoutCount: 0,
        sandboxBlockedCount: 0,
        lastCalledAt: null,
        latSum: 0,
        latCount: 0,
        byToolMap: new Map(),
      });
    }
  }

  return [...grouped.values()]
    .map((acc): McpSummaryRow => {
      const h = healthByServer.get(acc.serverName) ?? null;
      return {
        serverName: acc.serverName,
        totalCalls: acc.totalCalls,
        successCount: acc.successCount,
        fallbackCount: acc.fallbackCount,
        nativeSuccessCount: acc.nativeSuccessCount,
        failedCount: acc.failedCount,
        timeoutCount: acc.timeoutCount,
        sandboxBlockedCount: acc.sandboxBlockedCount,
        successRate:
          acc.totalCalls > 0 ? Number((acc.successCount / acc.totalCalls).toFixed(4)) : 0,
        nativeSuccessRate:
          acc.totalCalls > 0 ? Number((acc.nativeSuccessCount / acc.totalCalls).toFixed(4)) : 0,
        avgLatencyMs: acc.latCount > 0 ? Number((acc.latSum / acc.latCount).toFixed(2)) : null,
        health: h
          ? {
              circuitState: h.circuitState,
              failureCount: h.failureCount,
              successCount: h.successCount,
              lastFailureAt: h.lastFailureAt,
              lastSuccessAt: h.lastSuccessAt,
              openedAt: h.openedAt,
              lastErrorMessage: h.lastErrorMessage,
              updatedAt: h.updatedAt,
            }
          : null,
        byTool: [...acc.byToolMap.values()]
          .sort((a, b) => b.totalCalls - a.totalCalls)
          .slice(0, 10),
        lastCalledAt: acc.lastCalledAt,
      };
    })
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

export function isMcpFallbackResponse(response: unknown): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const root = response as Record<string, unknown>;
  const mcpResult =
    root.mcpResult && typeof root.mcpResult === "object" && !Array.isArray(root.mcpResult)
      ? (root.mcpResult as Record<string, unknown>)
      : root;
  const output =
    mcpResult.output && typeof mcpResult.output === "object" && !Array.isArray(mcpResult.output)
      ? (mcpResult.output as Record<string, unknown>)
      : mcpResult;
  return Boolean(output.__mcp_fallback);
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
