import { z } from "zod";
import { recipeSchema } from "./strategy-types";
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const strategyPolicySchema = z
  .object({
    method: z.literal("us_daily_top_n_v1"),
    benchmark: z.literal("equal_weight_daily"),
    minObservations: z.number().int().min(60).max(5000),
    minTrades: z.number().int().min(1).max(100000),
    minExcessReturn: z.number().finite().min(0).max(10),
    maxDrawdown: z.number().finite().min(0.01).max(0.8),
  })
  .strict();
export const strategyValidationRequestSchema = z
  .object({
    version: z.literal("sealed-strategy-request-v1"),
    attemptId: z.string().uuid(),
    protocolFingerprint: hash,
    planFingerprint: hash,
    strategyFingerprint: hash,
    datasetId: z.string().min(1).max(200),
    datasetFingerprint: hash,
    policyFingerprint: hash,
    recipe: recipeSchema,
  })
  .strict();
export const strategyValidationReceiptSchema = z
  .object({
    version: z.literal("sealed-strategy-v1"),
    attemptId: z.string().uuid(),
    protocolFingerprint: hash,
    planFingerprint: hash,
    strategyFingerprint: hash,
    datasetFingerprint: hash,
    policyFingerprint: hash,
    status: z.enum(["passed", "rejected", "insufficient_evidence"]),
    metrics: z
      .object({
        totalReturn: z.number().finite().nullable(),
        benchmarkReturn: z.number().finite().nullable(),
        maxDrawdown: z.number().finite().nullable(),
        observations: z.number().int().nonnegative(),
        tradeCount: z.number().int().nonnegative(),
      })
      .strict(),
    reasonCodes: z.array(z.string().max(120)).max(20),
    evaluatedAt: z.string(),
  })
  .strict();
export type StrategyValidationRequest = z.infer<typeof strategyValidationRequestSchema>;
export type StrategyValidationReceipt = z.infer<typeof strategyValidationReceiptSchema>;
