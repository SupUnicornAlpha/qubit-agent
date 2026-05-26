/**
 * 监控 · LLM 用量聚合（跨工作流，时间窗口内）。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §4.1.1 / §6.7 / §7.5）：
 *   - 数据源：llm_call_log（P1 起每次 reason LLM 调用一行）
 *   - 输出：
 *     - byProviderModel：每个 provider:model 的调用数 / token 三件套 / cost / 成功率
 *     - totals：窗口内总 token / 总 cost / 总错误数（前端 KPI 用）
 *     - errorTopN：错误消息 top 10（前端故障排查用）
 */
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { llmCallLog, workflowRun } from "../../db/sqlite/schema";

export type LlmUsageGroupRow = {
  provider: string;
  model: string;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  fallbackCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  avgLatencyMs: number | null;
  successRate: number;
  lastCalledAt: string | null;
};

export type LlmUsageSummary = {
  windowMinutes: number;
  totals: {
    totalCalls: number;
    successCount: number;
    errorCount: number;
    fallbackCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    avgLatencyMs: number | null;
    successRate: number;
  };
  byProviderModel: LlmUsageGroupRow[];
  errorTopN: Array<{ message: string; count: number }>;
};

export async function getLlmUsageSummary(input?: {
  windowMinutes?: number;
  sessionId?: string;
}): Promise<LlmUsageSummary> {
  const db = await getDb();
  const windowMinutes = clampInt(input?.windowMinutes ?? 24 * 60, 1, 7 * 24 * 60);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const sessionId = input?.sessionId;

  const rows = await db
    .select({
      provider: llmCallLog.provider,
      model: llmCallLog.model,
      status: llmCallLog.status,
      promptTokens: llmCallLog.promptTokens,
      completionTokens: llmCallLog.completionTokens,
      totalTokens: llmCallLog.totalTokens,
      latencyMs: llmCallLog.latencyMs,
      costUsd: llmCallLog.costUsd,
      errorMessage: llmCallLog.errorMessage,
      createdAt: llmCallLog.createdAt,
      sessionId: workflowRun.sessionId,
    })
    .from(llmCallLog)
    .leftJoin(workflowRun, eq(workflowRun.id, llmCallLog.workflowRunId))
    .where(
      and(
        gte(llmCallLog.createdAt, sinceIso),
        sessionId ? eq(workflowRun.sessionId, sessionId) : undefined
      )
    );

  type Acc = Omit<LlmUsageGroupRow, "successRate" | "avgLatencyMs"> & {
    latSum: number;
    latCount: number;
  };
  const grouped = new Map<string, Acc>();
  const errorCounter = new Map<string, number>();

  let totals = {
    totalCalls: 0,
    successCount: 0,
    errorCount: 0,
    fallbackCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    latSum: 0,
    latCount: 0,
  };

  for (const r of rows) {
    const key = `${r.provider}:${r.model}`;
    let acc = grouped.get(key);
    if (!acc) {
      acc = {
        provider: r.provider,
        model: r.model,
        totalCalls: 0,
        successCount: 0,
        errorCount: 0,
        fallbackCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        lastCalledAt: null,
        latSum: 0,
        latCount: 0,
      };
      grouped.set(key, acc);
    }

    acc.totalCalls += 1;
    totals.totalCalls += 1;
    if (r.status === "success") {
      acc.successCount += 1;
      totals.successCount += 1;
    } else if (r.status === "fallback") {
      acc.fallbackCount += 1;
      acc.successCount += 1; // fallback 仍然是成功输出
      totals.fallbackCount += 1;
      totals.successCount += 1;
    } else {
      acc.errorCount += 1;
      totals.errorCount += 1;
      if (r.errorMessage) {
        const msg = r.errorMessage.slice(0, 200);
        errorCounter.set(msg, (errorCounter.get(msg) ?? 0) + 1);
      }
    }

    acc.promptTokens += r.promptTokens ?? 0;
    acc.completionTokens += r.completionTokens ?? 0;
    acc.totalTokens += r.totalTokens ?? 0;
    acc.costUsd += r.costUsd ?? 0;

    totals.promptTokens += r.promptTokens ?? 0;
    totals.completionTokens += r.completionTokens ?? 0;
    totals.totalTokens += r.totalTokens ?? 0;
    totals.costUsd += r.costUsd ?? 0;

    if (typeof r.latencyMs === "number") {
      acc.latSum += r.latencyMs;
      acc.latCount += 1;
      totals.latSum += r.latencyMs;
      totals.latCount += 1;
    }
    if (!acc.lastCalledAt || r.createdAt > acc.lastCalledAt) {
      acc.lastCalledAt = r.createdAt;
    }
  }

  const byProviderModel: LlmUsageGroupRow[] = [...grouped.values()]
    .map(
      (acc): LlmUsageGroupRow => ({
        provider: acc.provider,
        model: acc.model,
        totalCalls: acc.totalCalls,
        successCount: acc.successCount,
        errorCount: acc.errorCount,
        fallbackCount: acc.fallbackCount,
        promptTokens: acc.promptTokens,
        completionTokens: acc.completionTokens,
        totalTokens: acc.totalTokens,
        costUsd: Number(acc.costUsd.toFixed(6)),
        avgLatencyMs:
          acc.latCount > 0 ? Number((acc.latSum / acc.latCount).toFixed(2)) : null,
        successRate:
          acc.totalCalls > 0
            ? Number((acc.successCount / acc.totalCalls).toFixed(4))
            : 0,
        lastCalledAt: acc.lastCalledAt,
      })
    )
    .sort((a, b) => b.totalCalls - a.totalCalls);

  const errorTopN = [...errorCounter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([message, count]) => ({ message, count }));

  return {
    windowMinutes,
    totals: {
      totalCalls: totals.totalCalls,
      successCount: totals.successCount,
      errorCount: totals.errorCount,
      fallbackCount: totals.fallbackCount,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      costUsd: Number(totals.costUsd.toFixed(6)),
      avgLatencyMs:
        totals.latCount > 0
          ? Number((totals.latSum / totals.latCount).toFixed(2))
          : null,
      successRate:
        totals.totalCalls > 0
          ? Number((totals.successCount / totals.totalCalls).toFixed(4))
          : 0,
    },
    byProviderModel,
    errorTopN,
  };
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
