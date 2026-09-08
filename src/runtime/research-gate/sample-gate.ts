/**
 * Sample / cross-section gates for ResearchRunContract.
 * Pure functions — no DB / provider I/O.
 */
import type { ResearchSampleStats } from "../research-dataset/types";
import {
  CROSS_SECTION_IC_HARD_MINIMUM_SYMBOLS,
  type ResearchRunContract,
  type ResearchRunIntent,
} from "./research-run-contract";

export type ResearchSampleGateResult = {
  okForPromotion: boolean;
  /** Eligible for strategy_validation labeling only when true; else research_only. */
  grade: "research_only" | "strategy_validation";
  missing: string[];
  sampleStats: ResearchSampleStats;
  contract: ResearchRunContract;
  /** Cross-section IC may be computed (not necessarily promotion-grade). */
  allowCrossSectionIcCompute: boolean;
  /** Cross-section IC must not be used as promotion evidence. */
  banCrossSectionIcPromotion: boolean;
};

export function assessResearchSampleGate(input: {
  sampleStats: ResearchSampleStats;
  contract: ResearchRunContract;
  hasDatasetSnapshot?: boolean;
  hasPreprocessSpec?: boolean;
}): ResearchSampleGateResult {
  const { sampleStats, contract } = input;
  const missing: string[] = [];
  const banCrossSectionIcPromotion =
    contract.intent === "single_name" || contract.intent === "thesis_only";

  if (banCrossSectionIcPromotion) {
    missing.push("cross_section_ic_banned_for_intent");
  }
  if (sampleStats.nSymbols < contract.dataset.minSymbols) {
    missing.push(
      `min_symbols:${sampleStats.nSymbols}<${contract.dataset.minSymbols}`
    );
  }
  if (sampleStats.nTradingDays < contract.dataset.minTradingDays) {
    missing.push(
      `min_trading_days:${sampleStats.nTradingDays}<${contract.dataset.minTradingDays}`
    );
  }
  if (contract.dataset.requirePIT && input.hasDatasetSnapshot === false) {
    missing.push("require_pit_dataset_snapshot");
  }
  if (contract.dataset.requirePreprocess && input.hasPreprocessSpec === false) {
    missing.push("require_preprocess_spec");
  }

  const allowCrossSectionIcCompute =
    !banCrossSectionIcPromotion &&
    sampleStats.nSymbols >= CROSS_SECTION_IC_HARD_MINIMUM_SYMBOLS;

  const okForPromotion = missing.length === 0;
  return {
    okForPromotion,
    grade: okForPromotion ? "strategy_validation" : "research_only",
    missing,
    sampleStats,
    contract,
    allowCrossSectionIcCompute,
    banCrossSectionIcPromotion,
  };
}

/**
 * Hard stop before calling a cross-section IC evaluator.
 * - single_name / thesis_only: always refuse IC as if it were a promotion path
 * - factor / strategy: need ≥ hard minimum symbols to compute
 */
export function assertCrossSectionIcComputeAllowed(input: {
  intent: ResearchRunIntent;
  nSymbols: number;
  factorId?: string;
}): void {
  if (input.intent === "single_name" || input.intent === "thesis_only") {
    throw new Error(
      `cross_section_ic_banned_for_intent: intent=${input.intent}` +
        (input.factorId ? ` factor=${input.factorId}` : "") +
        "；单标的/纯论点研究不得用横截面 IC/RankIC 作为评估或晋级证据。请改用时序指标、单标的回测，或将 intent 设为 factor 并扩大 universe。"
    );
  }
  if (input.nSymbols < CROSS_SECTION_IC_HARD_MINIMUM_SYMBOLS) {
    throw new Error(
      `cross_section_too_few_symbols: ` +
        (input.factorId ? `factor=${input.factorId} ` : "") +
        `当前仅 ${input.nSymbols} 只 symbols；IC/RankIC 是横截面指标，至少需要 ${CROSS_SECTION_IC_HARD_MINIMUM_SYMBOLS} 只（合同晋级门槛更高）。请扩大 universe 后重跑 factor.compute + factor.autoEvaluate。`
    );
  }
}
