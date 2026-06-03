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

/**
 * P3-2 扩展字段（监控闭环）：
 *   - cachedPromptTokens：prompt cache **read** 命中 token 总数
 *     → 配合 promptTokens 算 cacheHitRate
 *   - reasoningTokens：reasoning model 链式思考 token 总数（已含在 completion）
 *     → 配合 completionTokens 算 reasoningRatio
 *   - p50/p95FirstTokenLatencyMs：流式 TTFT 分位（user-visible 体感延迟）
 *   - finishReasonBreakdown：stop / length / content_filter / tool_calls / incomplete
 *     的频次，运营盯"截断率"用
 *   - lengthRetryCount：被网关 length-retry 自救过的调用数
 *
 * 老 caller 不读这些字段不会出错；旧数据库行 5 列为 null 时聚合为 0/null。
 */
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
  cachedPromptTokens: number;
  reasoningTokens: number;
  costUsd: number;
  avgLatencyMs: number | null;
  /** 流式首 token 延迟分位（仅在 firstTokenLatencyMs 不为 null 的样本上取） */
  p50FirstTokenLatencyMs: number | null;
  p95FirstTokenLatencyMs: number | null;
  /** finishReason 分布（key 经过 .toLowerCase().slice(0,32) 收敛；缺失/null 不计） */
  finishReasonBreakdown: Record<string, number>;
  /** 被网关 length-retry 自救的调用数（来自 requestMetaJson.lengthRetryUsed） */
  lengthRetryCount: number;
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
    cachedPromptTokens: number;
    reasoningTokens: number;
    costUsd: number;
    avgLatencyMs: number | null;
    p50FirstTokenLatencyMs: number | null;
    p95FirstTokenLatencyMs: number | null;
    finishReasonBreakdown: Record<string, number>;
    lengthRetryCount: number;
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
      promptCachedTokens: llmCallLog.promptCachedTokens,
      reasoningTokens: llmCallLog.reasoningTokens,
      firstTokenLatencyMs: llmCallLog.firstTokenLatencyMs,
      finishReason: llmCallLog.finishReason,
      latencyMs: llmCallLog.latencyMs,
      costUsd: llmCallLog.costUsd,
      errorMessage: llmCallLog.errorMessage,
      requestMetaJson: llmCallLog.requestMetaJson,
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

  /**
   * 按 provider:model 维度汇总。Acc 包含 latSum / latCount 等聚合中间量，
   * 也包含 ttftSamples（要算 p50/p95，需要保留原始样本）。
   */
  type Acc = {
    provider: string;
    model: string;
    totalCalls: number;
    successCount: number;
    errorCount: number;
    fallbackCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens: number;
    reasoningTokens: number;
    costUsd: number;
    lastCalledAt: string | null;
    latSum: number;
    latCount: number;
    ttftSamples: number[];
    finishReasonBreakdown: Map<string, number>;
    lengthRetryCount: number;
  };
  const grouped = new Map<string, Acc>();
  const errorCounter = new Map<string, number>();

  const totals = {
    totalCalls: 0,
    successCount: 0,
    errorCount: 0,
    fallbackCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedPromptTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    latSum: 0,
    latCount: 0,
    ttftSamples: [] as number[],
    finishReasonBreakdown: new Map<string, number>(),
    lengthRetryCount: 0,
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
        cachedPromptTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        lastCalledAt: null,
        latSum: 0,
        latCount: 0,
        ttftSamples: [],
        finishReasonBreakdown: new Map<string, number>(),
        lengthRetryCount: 0,
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
    acc.cachedPromptTokens += r.promptCachedTokens ?? 0;
    acc.reasoningTokens += r.reasoningTokens ?? 0;
    acc.costUsd += r.costUsd ?? 0;

    totals.promptTokens += r.promptTokens ?? 0;
    totals.completionTokens += r.completionTokens ?? 0;
    totals.totalTokens += r.totalTokens ?? 0;
    totals.cachedPromptTokens += r.promptCachedTokens ?? 0;
    totals.reasoningTokens += r.reasoningTokens ?? 0;
    totals.costUsd += r.costUsd ?? 0;

    if (typeof r.latencyMs === "number") {
      acc.latSum += r.latencyMs;
      acc.latCount += 1;
      totals.latSum += r.latencyMs;
      totals.latCount += 1;
    }
    if (typeof r.firstTokenLatencyMs === "number" && r.firstTokenLatencyMs >= 0) {
      acc.ttftSamples.push(r.firstTokenLatencyMs);
      totals.ttftSamples.push(r.firstTokenLatencyMs);
    }
    if (r.finishReason) {
      const norm = r.finishReason.toLowerCase().slice(0, 32);
      acc.finishReasonBreakdown.set(
        norm,
        (acc.finishReasonBreakdown.get(norm) ?? 0) + 1,
      );
      totals.finishReasonBreakdown.set(
        norm,
        (totals.finishReasonBreakdown.get(norm) ?? 0) + 1,
      );
    }
    /**
     * lengthRetry 标记落在 requestMetaJson；drizzle JSON 列读出来已是 object，
     * 但少数老行可能仍是字符串，统一兜底。
     */
    if (isLengthRetryUsed(r.requestMetaJson)) {
      acc.lengthRetryCount += 1;
      totals.lengthRetryCount += 1;
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
        cachedPromptTokens: acc.cachedPromptTokens,
        reasoningTokens: acc.reasoningTokens,
        costUsd: Number(acc.costUsd.toFixed(6)),
        avgLatencyMs:
          acc.latCount > 0 ? Number((acc.latSum / acc.latCount).toFixed(2)) : null,
        p50FirstTokenLatencyMs: percentile(acc.ttftSamples, 0.5),
        p95FirstTokenLatencyMs: percentile(acc.ttftSamples, 0.95),
        finishReasonBreakdown: Object.fromEntries(acc.finishReasonBreakdown),
        lengthRetryCount: acc.lengthRetryCount,
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
      cachedPromptTokens: totals.cachedPromptTokens,
      reasoningTokens: totals.reasoningTokens,
      costUsd: Number(totals.costUsd.toFixed(6)),
      avgLatencyMs:
        totals.latCount > 0
          ? Number((totals.latSum / totals.latCount).toFixed(2))
          : null,
      p50FirstTokenLatencyMs: percentile(totals.ttftSamples, 0.5),
      p95FirstTokenLatencyMs: percentile(totals.ttftSamples, 0.95),
      finishReasonBreakdown: Object.fromEntries(totals.finishReasonBreakdown),
      lengthRetryCount: totals.lengthRetryCount,
      successRate:
        totals.totalCalls > 0
          ? Number((totals.successCount / totals.totalCalls).toFixed(4))
          : 0,
    },
    byProviderModel,
    errorTopN,
  };
}

/**
 * 极简分位：样本量小（< 数千）所以原地排序 + 索引取值，O(n log n) 足够。
 * 空样本返回 null（"无数据"语义比 0 更准确，前端可以渲染 "—"）。
 */
function percentile(samples: number[], q: number): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  const v = sorted[idx];
  return typeof v === "number" ? Math.round(v) : null;
}

/**
 * 容错读 requestMetaJson.lengthRetryUsed：drizzle JSON 列正常情况下是 object，
 * 但老行偶尔被存成字符串（手工写入 / 历史 schema），先判 type 再 parse。
 */
function isLengthRetryUsed(meta: unknown): boolean {
  if (!meta) return false;
  let obj: unknown = meta;
  if (typeof meta === "string") {
    try {
      obj = JSON.parse(meta);
    } catch {
      return false;
    }
  }
  if (!obj || typeof obj !== "object") return false;
  return (obj as Record<string, unknown>)["lengthRetryUsed"] === true;
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
