/**
 * 监控 · Exec 维度聚合（跨工作流，时间窗口内）。
 *
 * 与 mcp-summary 同构。
 *
 * 数据源：exec_call_log（每次 shell.exec / cli_agent.run 调用一行）
 * 输出：按 (execKind, providerId) 聚合的调用数 / 状态分布 / latency / 输出量
 *      ＋ 按 errorCode 切分（让"很多 cwd_escape"这种治理异常一眼可见）
 *      ＋ byBinary（同 providerId 但 binary 可能不同——例如 claude-code provider
 *        的 binary 是 "claude"；保留两个维度便于排查"binary PATH 改了"）
 *
 * 不同于 mcp-summary 没有 health 表对应物——exec 没有熔断器（Bun.spawn 是即起即灭），
 * 失败诊断完全靠 errorCode 分布 + 个例 latency。
 */
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { execCallLog, workflowRun } from "../../db/sqlite/schema";

export type ExecKind = "shell" | "cli_agent";
export type ExecStatus = "success" | "error" | "timeout" | "sandbox_blocked";

export type ExecSummaryRow = {
  execKind: ExecKind;
  providerId: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  sandboxBlockedCount: number;
  truncatedCount: number;
  successRate: number; // 0..1
  avgLatencyMs: number | null;
  /** 平均 stdout 字节数（成功调用的 payload 规模感知） */
  avgStdoutBytes: number | null;
  /** 按 errorCode 切分（top 5），让"治理大量拦截 vs 实际执行失败"一眼可分 */
  byErrorCode: Array<{ errorCode: string; count: number }>;
  /** 按 binary 切分（top 5），cli_agent 场景看不同 agent CLI 的调用占比 */
  byBinary: Array<{ binary: string; totalCalls: number; successCount: number }>;
  lastCalledAt: string | null;
};

export async function getExecSummary(input?: {
  /** 时间窗口（分钟），默认 1440=24h，最大 7 * 24 * 60 */
  windowMinutes?: number;
  sessionId?: string;
  /** 按 execKind 过滤；缺省返回全部 */
  execKind?: ExecKind;
}): Promise<ExecSummaryRow[]> {
  const db = await getDb();
  const windowMinutes = clampInt(input?.windowMinutes ?? 24 * 60, 1, 7 * 24 * 60);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const sessionId = input?.sessionId;
  const filterKind = input?.execKind;

  const rows = await db
    .select({
      execKind: execCallLog.execKind,
      providerId: execCallLog.providerId,
      binary: execCallLog.binary,
      status: execCallLog.status,
      errorCode: execCallLog.errorCode,
      latencyMs: execCallLog.latencyMs,
      stdoutBytes: execCallLog.stdoutBytes,
      truncated: execCallLog.truncated,
      createdAt: execCallLog.createdAt,
      sessionId: workflowRun.sessionId,
    })
    .from(execCallLog)
    .leftJoin(workflowRun, eq(workflowRun.id, execCallLog.workflowRunId))
    .where(
      and(
        gte(execCallLog.createdAt, sinceIso),
        sessionId ? eq(workflowRun.sessionId, sessionId) : undefined,
        filterKind ? eq(execCallLog.execKind, filterKind) : undefined
      )
    );

  type Acc = Omit<
    ExecSummaryRow,
    "successRate" | "avgLatencyMs" | "avgStdoutBytes" | "byErrorCode" | "byBinary"
  > & {
    latSum: number;
    latCount: number;
    stdoutSum: number;
    stdoutCount: number;
    errorCodeMap: Map<string, number>;
    binaryMap: Map<string, { binary: string; totalCalls: number; successCount: number }>;
  };

  const grouped = new Map<string, Acc>();
  for (const r of rows) {
    const key = `${r.execKind}::${r.providerId}`;
    let acc = grouped.get(key);
    if (!acc) {
      acc = {
        execKind: r.execKind as ExecKind,
        providerId: r.providerId,
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        timeoutCount: 0,
        sandboxBlockedCount: 0,
        truncatedCount: 0,
        lastCalledAt: null,
        latSum: 0,
        latCount: 0,
        stdoutSum: 0,
        stdoutCount: 0,
        errorCodeMap: new Map(),
        binaryMap: new Map(),
      };
      grouped.set(key, acc);
    }
    acc.totalCalls += 1;
    const status = r.status as ExecStatus;
    if (status === "success") acc.successCount += 1;
    else if (status === "timeout") acc.timeoutCount += 1;
    else if (status === "sandbox_blocked") acc.sandboxBlockedCount += 1;
    else acc.errorCount += 1;

    if (r.truncated === 1) acc.truncatedCount += 1;

    if (typeof r.latencyMs === "number") {
      acc.latSum += r.latencyMs;
      acc.latCount += 1;
    }
    if (status === "success" && typeof r.stdoutBytes === "number") {
      acc.stdoutSum += r.stdoutBytes;
      acc.stdoutCount += 1;
    }
    if (r.errorCode) {
      acc.errorCodeMap.set(r.errorCode, (acc.errorCodeMap.get(r.errorCode) ?? 0) + 1);
    }
    const b = acc.binaryMap.get(r.binary) ?? { binary: r.binary, totalCalls: 0, successCount: 0 };
    b.totalCalls += 1;
    if (status === "success") b.successCount += 1;
    acc.binaryMap.set(r.binary, b);

    if (!acc.lastCalledAt || r.createdAt > acc.lastCalledAt) acc.lastCalledAt = r.createdAt;
  }

  return [...grouped.values()]
    .map(
      (acc): ExecSummaryRow => ({
        execKind: acc.execKind,
        providerId: acc.providerId,
        totalCalls: acc.totalCalls,
        successCount: acc.successCount,
        errorCount: acc.errorCount,
        timeoutCount: acc.timeoutCount,
        sandboxBlockedCount: acc.sandboxBlockedCount,
        truncatedCount: acc.truncatedCount,
        successRate:
          acc.totalCalls > 0 ? Number((acc.successCount / acc.totalCalls).toFixed(4)) : 0,
        avgLatencyMs: acc.latCount > 0 ? Number((acc.latSum / acc.latCount).toFixed(2)) : null,
        avgStdoutBytes:
          acc.stdoutCount > 0 ? Number((acc.stdoutSum / acc.stdoutCount).toFixed(0)) : null,
        byErrorCode: [...acc.errorCodeMap.entries()]
          .map(([errorCode, count]) => ({ errorCode, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 5),
        byBinary: [...acc.binaryMap.values()]
          .sort((a, b) => b.totalCalls - a.totalCalls)
          .slice(0, 5),
        lastCalledAt: acc.lastCalledAt,
      })
    )
    .sort((a, b) => b.totalCalls - a.totalCalls);
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
