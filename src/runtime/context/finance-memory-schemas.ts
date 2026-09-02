/**
 * Finance Memory zod 门禁（05 §4.4.3 · A3/A5/A6）
 */

import { z } from "zod";

export const FactorArchiveMetaSchema = z.object({
  factorId: z.string().min(1),
  evaluationId: z.string().optional(),
  name: z.string().min(1),
  category: z.string().min(1),
  universe: z.string().min(1),
  horizon: z.union([z.string(), z.number()]).transform(String),
  ic: z.number().optional(),
  rankIc: z.number().optional(),
  ir: z.number().optional(),
  asof: z.string().min(1),
  sampleSize: z.number().int().optional(),
  memoryTier: z.enum(["shallow", "intermediate", "deep"]).default("deep"),
});

export type FactorArchiveMeta = z.infer<typeof FactorArchiveMetaSchema>;

export const ResearchConclusionMetaSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1),
  stance: z.enum(["bull", "bear", "neutral", "hold", "unknown"]),
  confidence: z.number().min(0).max(1),
  asof: z.string().min(1),
  horizon: z.string().optional(),
  thesis: z.string().min(1),
  risks: z.array(z.string()).optional(),
  quantAnchor: z
    .object({
      factorIds: z.array(z.string()).optional(),
      compositionIds: z.array(z.string()).optional(),
      evaluationIds: z.array(z.string()).optional(),
    })
    .optional(),
  workflowRunId: z.string().optional(),
  memoryTier: z.literal("intermediate").default("intermediate"),
});

export type ResearchConclusionMeta = z.infer<typeof ResearchConclusionMetaSchema>;

/**
 * Host-stamped evidence attached only after the exact composition has passed
 * the reusable-strategy evidence gate. This is intentionally a compact
 * reference to immutable runs rather than a copy of performance claims.
 */
export const StrategyRecipeValidationEvidenceSchema = z.object({
  status: z.literal("validated"),
  strategyVersionId: z.string().min(1),
  compositionId: z.string().min(1),
  backtestRunId: z.string().min(1),
  datasetSnapshotId: z.string().min(1),
  comparisonCohortId: z.string().min(1),
  finalHoldoutFingerprint: z.string().min(1),
  verifiedAt: z.string().min(1),
});

export type StrategyRecipeValidationEvidence = z.infer<
  typeof StrategyRecipeValidationEvidenceSchema
>;

export const StrategyRecipeMetaSchema = z.object({
  compositionId: z.string().min(1),
  factorIds: z.array(z.string()).default([]),
  ruleIds: z.array(z.string()).default([]),
  weightMethod: z.string().optional(),
  rebalanceFreq: z.string().optional(),
  asof: z.string().min(1),
  memoryTier: z.enum(["shallow", "intermediate", "deep"]).default("deep"),
  validationEvidence: StrategyRecipeValidationEvidenceSchema.optional(),
});

export type StrategyRecipeMeta = z.infer<typeof StrategyRecipeMetaSchema>;

export function hasValidatedStrategyRecipeEvidence(
  value: unknown
): value is StrategyRecipeValidationEvidence {
  return StrategyRecipeValidationEvidenceSchema.safeParse(value).success;
}

export const StrategyEvalMetaSchema = z.object({
  compositionId: z.string().min(1).optional(),
  strategyVersionId: z.string().min(1).optional(),
  backtestRunId: z.string().min(1).optional(),
  evalKind: z
    .enum(["backtest", "paper", "shadow", "live", "walk_forward", "recommendation"])
    .default("backtest"),
  metrics: z.record(z.unknown()).default({}),
  universe: z.string().optional(),
  qualityScore: z.number().min(0).max(1).optional(),
  pass: z.boolean().optional(),
  asof: z.string().min(1),
  memoryTier: z.literal("intermediate").default("intermediate"),
});

export type StrategyEvalMeta = z.infer<typeof StrategyEvalMetaSchema>;

export const PnlEpisodeMetaSchema = z.object({
  strategyRuntimeId: z.string().min(1).optional(),
  tradingDay: z.string().min(1),
  symbol: z.string().min(1),
  realized: z.number(),
  unrealized: z.number().optional(),
  fee: z.number().optional(),
  turnover: z.number().optional(),
  asof: z.string().min(1),
  memoryTier: z.literal("intermediate").default("intermediate"),
});

export type PnlEpisodeMeta = z.infer<typeof PnlEpisodeMetaSchema>;

export const MarketSnapshotMetaSchema = z.object({
  symbols: z.array(z.string().min(1)).min(1),
  asof: z.string().min(1),
  indicatorsBrief: z.string().min(1),
  dataSource: z.string().min(1).default("analyst-team-context"),
  decayHours: z.number().positive().default(48),
  memoryTier: z.literal("shallow").default("shallow"),
});

export type MarketSnapshotMeta = z.infer<typeof MarketSnapshotMetaSchema>;

export type FinanceMemoryValidateOk<T> = { ok: true; data: T };
export type FinanceMemoryValidateErr = {
  ok: false;
  errorCode: "finance_memory_schema_invalid";
  message: string;
  issues: string[];
};

export function validateFactorArchiveMeta(
  raw: unknown
): FinanceMemoryValidateOk<FactorArchiveMeta> | FinanceMemoryValidateErr {
  const parsed = FactorArchiveMetaSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: "finance_memory_schema_invalid",
      message: "factor_archive metadata invalid",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, data: parsed.data };
}

export function validateResearchConclusionMeta(
  raw: unknown
): FinanceMemoryValidateOk<ResearchConclusionMeta> | FinanceMemoryValidateErr {
  const parsed = ResearchConclusionMetaSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: "finance_memory_schema_invalid",
      message: "research_conclusion metadata invalid",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, data: parsed.data };
}

export function validateStrategyRecipeMeta(
  raw: unknown
): FinanceMemoryValidateOk<StrategyRecipeMeta> | FinanceMemoryValidateErr {
  const parsed = StrategyRecipeMetaSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: "finance_memory_schema_invalid",
      message: "strategy_recipe metadata invalid",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, data: parsed.data };
}

export function validateStrategyEvalMeta(
  raw: unknown
): FinanceMemoryValidateOk<StrategyEvalMeta> | FinanceMemoryValidateErr {
  const parsed = StrategyEvalMetaSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: "finance_memory_schema_invalid",
      message: "strategy_eval metadata invalid",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, data: parsed.data };
}

export function validatePnlEpisodeMeta(
  raw: unknown
): FinanceMemoryValidateOk<PnlEpisodeMeta> | FinanceMemoryValidateErr {
  const parsed = PnlEpisodeMetaSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: "finance_memory_schema_invalid",
      message: "pnl_episode metadata invalid",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, data: parsed.data };
}

export function validateMarketSnapshotMeta(
  raw: unknown
): FinanceMemoryValidateOk<MarketSnapshotMeta> | FinanceMemoryValidateErr {
  const parsed = MarketSnapshotMetaSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorCode: "finance_memory_schema_invalid",
      message: "market_snapshot metadata invalid",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  return { ok: true, data: parsed.data };
}
