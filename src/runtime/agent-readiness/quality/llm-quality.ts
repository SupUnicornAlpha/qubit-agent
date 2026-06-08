/**
 * C 类 · LLM 调用质量与适配。
 *
 *   C-1 调用成功率   = (success + fallback) / total（fallback 也算成功——它是降级路径完成的）
 *   C-2 主路径失败比例 = (error + timeout + fallback) / total
 *                       — schema 没有 retry_count，但 fallback 是"主模型失败转备模型"的强信号；
 *                         用它来表达"模型路径不健康"
 *   C-3 token        = 三个独立指标：total / max / p95
 *   C-5 截断率       = finishReason ∈ {length, max_tokens, max_output_tokens, incomplete} 的比例
 *
 * C-4（模型适配）依赖 agent_definition × role × model 矩阵，依赖外部上下文，
 * 在 thresholds.ts 阶段做规则判定，本文件不直接抓——保留接口位。
 *
 * 所有指标在"无 LLM 调用"时返回 null（无法判定）。
 */
import type { Database } from "bun:sqlite";

export interface LlmQualityResult {
  "C-1": number | null;
  "C-2": number | null;
  "C-3-total": number;
  "C-3-max": number | null;
  "C-3-p95": number | null;
  "C-5": number | null;
  details: {
    total: number;
    successCount: number;
    errorCount: number;
    fallbackCount: number;
    timeoutCount: number;
    truncatedCount: number;
    /** 按 (provider, model) 切分调用次数，给 C-4 / reporter 用 */
    byModel: Array<{ provider: string; model: string; count: number; tokens: number }>;
  };
}

const TRUNCATED_FINISH = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "incomplete",
]);

interface LlmRow {
  status: string;
  totalTokens: number | null;
  finishReason: string | null;
  provider: string;
  model: string;
}

export async function collectLlmQuality(
  sqlite: Database,
  workflowRunId: string
): Promise<LlmQualityResult> {
  const rows = sqlite
    .prepare(
      `SELECT status,
              total_tokens AS totalTokens,
              finish_reason AS finishReason,
              provider,
              model
       FROM llm_call_log WHERE workflow_run_id = ?`
    )
    .all(workflowRunId) as LlmRow[];

  if (!rows.length) {
    return {
      "C-1": null,
      "C-2": null,
      "C-3-total": 0,
      "C-3-max": null,
      "C-3-p95": null,
      "C-5": null,
      details: {
        total: 0,
        successCount: 0,
        errorCount: 0,
        fallbackCount: 0,
        timeoutCount: 0,
        truncatedCount: 0,
        byModel: [],
      },
    };
  }

  let successCount = 0;
  let errorCount = 0;
  let timeoutCount = 0;
  let fallbackCount = 0;
  let truncatedCount = 0;
  let tokenSum = 0;
  let tokenMax = 0;
  const tokenSeries: number[] = [];
  const byModelMap = new Map<
    string,
    { provider: string; model: string; count: number; tokens: number }
  >();

  for (const r of rows) {
    if (r.status === "success") successCount++;
    else if (r.status === "fallback") fallbackCount++;
    else if (r.status === "timeout") timeoutCount++;
    else if (r.status === "error") errorCount++;
    if (r.totalTokens != null) {
      tokenSum += r.totalTokens;
      tokenMax = Math.max(tokenMax, r.totalTokens);
      tokenSeries.push(r.totalTokens);
    }
    if (r.finishReason && TRUNCATED_FINISH.has(r.finishReason.toLowerCase())) {
      truncatedCount++;
    }
    const key = `${r.provider}/${r.model}`;
    const acc = byModelMap.get(key);
    if (acc) {
      acc.count++;
      acc.tokens += r.totalTokens ?? 0;
    } else {
      byModelMap.set(key, {
        provider: r.provider,
        model: r.model,
        count: 1,
        tokens: r.totalTokens ?? 0,
      });
    }
  }

  const total = rows.length;
  const c1 = (successCount + fallbackCount) / total;
  const c2 = (errorCount + timeoutCount + fallbackCount) / total;
  const c5 = truncatedCount / total;

  const sorted = [...tokenSeries].sort((a, b) => a - b);
  const p95Index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  const c3p95 = sorted.length ? sorted[p95Index] : null;

  return {
    "C-1": c1,
    "C-2": c2,
    "C-3-total": tokenSum,
    "C-3-max": tokenMax || null,
    "C-3-p95": c3p95 ?? null,
    "C-5": c5,
    details: {
      total,
      successCount,
      errorCount,
      fallbackCount,
      timeoutCount,
      truncatedCount,
      byModel: [...byModelMap.values()].sort((a, b) => b.count - a.count),
    },
  };
}
