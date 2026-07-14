/**
 * 监控 · Tool 维度聚合（跨工作流，时间窗口内）。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §4.1.2 / §6.7）：
 *   - 数据源：tool_call_log（acp_connector / mcp / skill / builtin 四种 toolKind）
 *   - 输出：按 (toolKind, toolName) 聚合的调用数 / 成功 / 失败 / 平均 latency
 *   - 不依赖 join agent_step（P1 起 tool_call_log 已带 workflow_run_id），
 *     单次扫表即可
 */
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { toolCallLog, workflowRun } from "../../db/sqlite/schema";

export type ToolKind = "acp_connector" | "mcp" | "skill" | "builtin";

export type ToolSummaryRow = {
  toolKind: ToolKind;
  toolName: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  sandboxBlockedCount: number;
  successRate: number; // 0..1
  /** Empty/no-data responses are persisted as errors; expose them separately from transport faults. */
  noDataCount: number;
  transportErrorCount: number;
  effectiveDataSuccessRate: number; // success / (success + no-data + transport errors + timeout)
  avgLatencyMs: number | null;
  lastCalledAt: string | null;
};

export async function getToolsSummary(input?: {
  /** 时间窗口（分钟），默认 1440=24h，最大 7 * 24 * 60 */
  windowMinutes?: number;
  sessionId?: string;
  /** 按 toolKind 过滤，缺省返回全部 */
  toolKind?: ToolKind;
}): Promise<ToolSummaryRow[]> {
  const db = await getDb();
  const windowMinutes = clampInt(input?.windowMinutes ?? 24 * 60, 1, 7 * 24 * 60);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const sessionId = input?.sessionId;
  const filterKind = input?.toolKind;

  // sessionId 过滤要 join workflow_run；不过滤时跳过 join 减少一次表访问
  const baseSelect = {
    toolKind: toolCallLog.toolKind,
    toolName: toolCallLog.toolName,
    status: toolCallLog.status,
    errorMessage: toolCallLog.errorMessage,
    latencyMs: toolCallLog.latencyMs,
    createdAt: toolCallLog.createdAt,
    sessionId: workflowRun.sessionId,
  };

  const rows = sessionId
    ? await db
        .select(baseSelect)
        .from(toolCallLog)
        .leftJoin(workflowRun, eq(workflowRun.id, toolCallLog.workflowRunId))
        .where(
          and(
            gte(toolCallLog.createdAt, sinceIso),
            eq(workflowRun.sessionId, sessionId),
            filterKind ? eq(toolCallLog.toolKind, filterKind) : undefined
          )
        )
    : await db
        .select(baseSelect)
        .from(toolCallLog)
        .leftJoin(workflowRun, eq(workflowRun.id, toolCallLog.workflowRunId))
        .where(
          and(
            gte(toolCallLog.createdAt, sinceIso),
            filterKind ? eq(toolCallLog.toolKind, filterKind) : undefined
          )
        );

  type Acc = Omit<ToolSummaryRow, "successRate" | "effectiveDataSuccessRate" | "avgLatencyMs"> & {
    latSum: number;
    latCount: number;
  };
  const grouped = new Map<string, Acc>();
  for (const r of rows) {
    const key = `${r.toolKind}::${r.toolName}`;
    let acc = grouped.get(key);
    if (!acc) {
      acc = {
        toolKind: r.toolKind as ToolKind,
        toolName: r.toolName,
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        timeoutCount: 0,
        sandboxBlockedCount: 0,
        noDataCount: 0,
        transportErrorCount: 0,
        lastCalledAt: null,
        latSum: 0,
        latCount: 0,
      };
      grouped.set(key, acc);
    }
    acc.totalCalls += 1;
    if (r.status === "success") acc.successCount += 1;
    else if (r.status === "timeout") acc.timeoutCount += 1;
    else if (r.status === "sandbox_blocked") acc.sandboxBlockedCount += 1;
    else {
      acc.errorCount += 1;
      if ((r.errorMessage ?? "").startsWith("semantic_data_failure:")) acc.noDataCount += 1;
      else acc.transportErrorCount += 1;
    }
    if (typeof r.latencyMs === "number") {
      acc.latSum += r.latencyMs;
      acc.latCount += 1;
    }
    if (!acc.lastCalledAt || r.createdAt > acc.lastCalledAt) {
      acc.lastCalledAt = r.createdAt;
    }
  }

  return [...grouped.values()]
    .map(
      (acc): ToolSummaryRow => ({
        toolKind: acc.toolKind,
        toolName: acc.toolName,
        totalCalls: acc.totalCalls,
        successCount: acc.successCount,
        errorCount: acc.errorCount,
        timeoutCount: acc.timeoutCount,
        sandboxBlockedCount: acc.sandboxBlockedCount,
        successRate:
          acc.totalCalls > 0 ? Number((acc.successCount / acc.totalCalls).toFixed(4)) : 0,
        noDataCount: acc.noDataCount,
        transportErrorCount: acc.transportErrorCount,
        effectiveDataSuccessRate:
          acc.successCount + acc.errorCount + acc.timeoutCount > 0
            ? Number(
                (acc.successCount / (acc.successCount + acc.errorCount + acc.timeoutCount)).toFixed(
                  4
                )
              )
            : 0,
        avgLatencyMs: acc.latCount > 0 ? Number((acc.latSum / acc.latCount).toFixed(2)) : null,
        lastCalledAt: acc.lastCalledAt,
      })
    )
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
