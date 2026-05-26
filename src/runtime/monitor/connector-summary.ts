/**
 * 监控 · Connector 维度聚合（窗口内）。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §4.1.5）：
 *   - 数据源：connector_call_log（每次 ACP→connector 调用写一行，op=init/healthcheck/execute/shutdown）
 *   - 按 connector_name 聚合：调用次数 / 成功率 / 平均/P95 延迟 / 最近一次错误
 *   - 与 skills-summary / tools-summary 一致的窗口语义（默认 24h，最大 7d）
 *
 * P2-H：表已有打点（acp-monitoring-hook），但此前监控 routes 没有暴露聚合查询；
 *       本服务把这一公里补齐，让前端 monitor 页能在 Connector tab 里直接看到数据。
 */
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { connectorCallLog } from "../../db/sqlite/schema";

export type ConnectorSummaryRow = {
  connectorName: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  successRate: number; // 0..1
  avgLatencyMs: number;
  p95LatencyMs: number;
  lastCallAt: string | null;
  lastErrorMessage: string | null;
  /** 按 operation 拆解的小计（execute/healthcheck/init/shutdown 各占多少） */
  operationBreakdown: Record<string, number>;
};

export async function getConnectorsSummary(input?: {
  /** 时间窗口（分钟），默认 1440=24h，最大 7d */
  windowMinutes?: number;
  /** 按 workflow_run_id 过滤；空 = 全窗口 */
  workflowRunId?: string;
}): Promise<ConnectorSummaryRow[]> {
  const db = await getDb();
  const windowMinutes = clampInt(input?.windowMinutes ?? 24 * 60, 1, 7 * 24 * 60);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const whereExpr = input?.workflowRunId
    ? and(
        gte(connectorCallLog.createdAt, sinceIso),
        eq(connectorCallLog.workflowRunId, input.workflowRunId),
      )
    : gte(connectorCallLog.createdAt, sinceIso);

  const rows = await db
    .select({
      connectorName: connectorCallLog.connectorName,
      operation: connectorCallLog.operation,
      latencyMs: connectorCallLog.latencyMs,
      status: connectorCallLog.status,
      errorMessage: connectorCallLog.errorMessage,
      createdAt: connectorCallLog.createdAt,
    })
    .from(connectorCallLog)
    .where(whereExpr)
    .orderBy(desc(connectorCallLog.createdAt))
    .limit(20_000);

  /**
   * 按 connectorName 分桶；P95 用 sorted array nth 取，足够实用，
   * 不要求精确的 t-digest（数据量 < 2w 行可接受 O(n log n)）。
   */
  const grouped = new Map<string, ConnectorSummaryRow & { latencies: number[] }>();
  for (const r of rows) {
    const key = r.connectorName || "(unknown)";
    let g = grouped.get(key);
    if (!g) {
      g = {
        connectorName: key,
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        timeoutCount: 0,
        successRate: 0,
        avgLatencyMs: 0,
        p95LatencyMs: 0,
        lastCallAt: null,
        lastErrorMessage: null,
        operationBreakdown: {},
        latencies: [],
      };
      grouped.set(key, g);
    }
    g.totalCalls += 1;
    if (r.status === "success") g.successCount += 1;
    else if (r.status === "timeout") g.timeoutCount += 1;
    else g.errorCount += 1;
    g.latencies.push(r.latencyMs);
    g.operationBreakdown[r.operation] = (g.operationBreakdown[r.operation] ?? 0) + 1;
    if (g.lastCallAt === null || r.createdAt > g.lastCallAt) {
      g.lastCallAt = r.createdAt;
    }
    if (r.status !== "success" && r.errorMessage && !g.lastErrorMessage) {
      g.lastErrorMessage = r.errorMessage.slice(0, 240);
    }
  }

  return Array.from(grouped.values())
    .map(({ latencies, ...rest }) => {
      const sorted = latencies.slice().sort((a, b) => a - b);
      const avg =
        sorted.length === 0
          ? 0
          : Math.round(sorted.reduce((s, n) => s + n, 0) / sorted.length);
      const p95Idx = Math.max(0, Math.floor(sorted.length * 0.95) - 1);
      const p95 = sorted.length === 0 ? 0 : sorted[p95Idx] ?? 0;
      return {
        ...rest,
        successRate: rest.totalCalls === 0 ? 0 : rest.successCount / rest.totalCalls,
        avgLatencyMs: avg,
        p95LatencyMs: p95,
      };
    })
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

function clampInt(v: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? Math.round(v) : min;
  return Math.max(min, Math.min(max, n));
}
