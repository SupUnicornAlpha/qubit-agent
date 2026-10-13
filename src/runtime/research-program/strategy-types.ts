import { z } from "zod";
export const strategyExecutionSchema = z
  .object({
    capital: z.number().finite().min(1000).max(1e9),
    topN: z.number().int().min(1).max(100),
    rebalance: z.enum(["daily", "weekly", "monthly"]),
    commissionBps: z.number().finite().min(0).max(100),
    slippageBps: z.number().finite().min(0).max(100),
    minCommission: z.number().finite().min(0).max(1000),
    maxVolumeParticipation: z.number().finite().min(0.001).max(0.1),
  })
  .strict();
export type StrategyExecution = z.infer<typeof strategyExecutionSchema>;
export const recipeSchema = z
  .object({
    format: z.literal("qubit-research-strategy-v1"),
    sourceAttemptId: z.string(),
    sourceProtocolId: z.string(),
    factor: z
      .object({
        id: z.string(),
        name: z.string(),
        expr: z.string(),
        universe: z.literal("US"),
        direction: z.union([z.literal(1), z.literal(-1)]),
      })
      .strict(),
    development: z
      .object({
        datasetSnapshotId: z.string(),
        symbols: z.array(z.string()),
        startDate: z.string(),
        endDate: z.string(),
      })
      .strict(),
    execution: strategyExecutionSchema,
    scope: z.literal("development_only"),
    allocation: z.literal("long_only_top_n_equal"),
    timing: z.literal("close_signal_next_open"),
    engine: z.literal("event_driven"),
  })
  .strict();
export type ResearchStrategyRecipe = z.infer<typeof recipeSchema>;

/** The same frozen execution contract is checked by the ordinary backtest entry point. */
export function frozenStrategyRequest(
  versionId: string,
  recipe: ResearchStrategyRecipe,
  fingerprint: string,
  createdAt: string
) {
  const x = recipe.execution;
  return {
    strategyVersionId: versionId,
    ...recipe.development,
    timeframe: "1d",
    universe: "US",
    signals: {
      kind: "factor_score" as const,
      expr: recipe.factor.expr,
      lang: "qlib_expr" as const,
      reverse: recipe.factor.direction === -1,
    },
    capital: x.capital,
    topN: x.topN,
    rebalance: x.rebalance,
    longShort: false,
    providerKey: "event_driven",
    costs: {
      commissionBps: x.commissionBps,
      slippageBps: x.slippageBps,
      minCommission: x.minCommission,
      maxVolumeParticipation: x.maxVolumeParticipation,
      slippageModel: "fixed_bps" as const,
      costModelVersion: fingerprint,
      costModelSource: "predeclared_research_assumption",
      costModelAsOf: createdAt,
    },
    experiment: { parameterSelection: "unknown" as const, preRegistrationId: versionId },
  };
}
