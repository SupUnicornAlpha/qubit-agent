/**
 * Self-Evolving Agent P5 — SkillPromoter 评分纯函数层。
 *
 * 设计原则（同 pnl-calc.ts）：
 *   - 0 依赖 DB / 时间，全部 input 走参数；
 *   - 所有边界 case 由本文件 + scoring.test.ts 覆盖，worker 集成测只验编排；
 *   - 规则与权重写死在 v0；P6 起接 LLM judge 时把 score 维度拓展到这里即可。
 *
 * 规则 v0（与 docs/SELF_EVOLVING_AGENT_DESIGN.md §6.3 一致）：
 *   gate 1: useCount >= MIN_RECALL（默认 3）
 *   gate 2: executedCount (= success + fail) >= MIN_EXEC（默认 2）
 *   gate 3: successRate (= success / executed) >= MIN_SUCCESS_RATE（默认 0.6）
 *   gate 4: qualityScore >= MIN_QUALITY（默认 0.5）
 * 通过全部 gate 则 qualified=true，进入加权：
 *   score = w_recall  * sigmoid(log1p(useCount) / log1p(USE_CAP))
 *         + w_success * successRate
 *         + w_quality * qualityScore
 *         + w_pnl     * pnlSignal
 * 权重默认 0.4 / 0.3 / 0.2 / 0.1（PnL v0 = 0.5 中性）。
 */

import type { PromoterCandidate, PromoterScore, PromoterRuleHit } from "./types";

export interface PromoterScoringConfig {
  minRecall: number;
  minExec: number;
  minSuccessRate: number;
  minQuality: number;
  useCap: number;
  weights: {
    recall: number;
    success: number;
    quality: number;
    pnl: number;
  };
}

export const DEFAULT_SCORING_CONFIG: PromoterScoringConfig = {
  minRecall: 3,
  minExec: 2,
  minSuccessRate: 0.6,
  minQuality: 0.5,
  useCap: 20,
  weights: { recall: 0.4, success: 0.3, quality: 0.2, pnl: 0.1 },
};

export function scoreCandidate(
  c: PromoterCandidate,
  cfg: PromoterScoringConfig = DEFAULT_SCORING_CONFIG
): PromoterScore {
  const executedCount = c.successCount + c.failCount;
  const successRate = executedCount > 0 ? c.successCount / executedCount : 0;

  const ruleHits: PromoterRuleHit[] = [];

  const recallPassed = c.useCount >= cfg.minRecall;
  ruleHits.push({
    rule: "gate_recall",
    passed: recallPassed,
    detail: `useCount=${c.useCount} (min=${cfg.minRecall})`,
    contribution: 0,
  });

  const execPassed = executedCount >= cfg.minExec;
  ruleHits.push({
    rule: "gate_exec",
    passed: execPassed,
    detail: `executed=${executedCount} (min=${cfg.minExec})`,
    contribution: 0,
  });

  const successPassed = successRate >= cfg.minSuccessRate;
  ruleHits.push({
    rule: "gate_success_rate",
    passed: successPassed,
    detail: `${(successRate * 100).toFixed(1)}% (min=${(cfg.minSuccessRate * 100).toFixed(0)}%)`,
    contribution: 0,
  });

  const qualityPassed = c.qualityScore >= cfg.minQuality;
  ruleHits.push({
    rule: "gate_quality",
    passed: qualityPassed,
    detail: `q=${c.qualityScore.toFixed(2)} (min=${cfg.minQuality})`,
    contribution: 0,
  });

  // ── 任何 gate 未过：早返回 ─────────────────────────────────────
  if (!recallPassed) {
    return { score: 0, qualified: false, ruleHits, skipReason: "low_recall" };
  }
  if (!execPassed) {
    return { score: 0, qualified: false, ruleHits, skipReason: "insufficient_data" };
  }
  if (!successPassed) {
    return { score: 0, qualified: false, ruleHits, skipReason: "low_success_rate" };
  }
  if (!qualityPassed) {
    return { score: 0, qualified: false, ruleHits, skipReason: "low_quality" };
  }

  // ── 全过 → 加权 ───────────────────────────────────────────────
  const recallNorm = sigmoid01(Math.log1p(c.useCount) / Math.log1p(cfg.useCap));
  const successNorm = clamp01(successRate);
  const qualityNorm = clamp01(c.qualityScore);
  const pnlNorm = clamp01(c.pnlSignal);

  const cRecall = cfg.weights.recall * recallNorm;
  const cSuccess = cfg.weights.success * successNorm;
  const cQuality = cfg.weights.quality * qualityNorm;
  const cPnl = cfg.weights.pnl * pnlNorm;

  ruleHits.push({
    rule: "score_recall",
    passed: true,
    detail: `useCount=${c.useCount} → norm=${recallNorm.toFixed(3)}`,
    contribution: cRecall,
  });
  ruleHits.push({
    rule: "score_success",
    passed: true,
    detail: `rate=${(successRate * 100).toFixed(1)}%`,
    contribution: cSuccess,
  });
  ruleHits.push({
    rule: "score_quality",
    passed: true,
    detail: `q=${c.qualityScore.toFixed(2)}`,
    contribution: cQuality,
  });
  ruleHits.push({
    rule: "score_pnl",
    passed: true,
    detail: `signal=${c.pnlSignal.toFixed(2)} (v0 中性 0.5)`,
    contribution: cPnl,
  });

  const score = clamp01(cRecall + cSuccess + cQuality + cPnl);
  return { score, qualified: true, ruleHits };
}

/** 0..1 内截断 */
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Math.log1p(useCount) / Math.log1p(cap) → 已经在 [0, 1]+ 区间，clamp 之 */
function sigmoid01(x: number): number {
  return clamp01(x);
}
