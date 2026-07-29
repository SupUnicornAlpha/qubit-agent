/**
 * Finance Memory zod 门禁（05 §4.4.3 · A3/A5/A6）
 */

import { z } from "zod";
import type { MemoryTier } from "./types";

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

export const StrategyRecipeMetaSchema = z.object({
  compositionId: z.string().min(1),
  factorIds: z.array(z.string()).default([]),
  ruleIds: z.array(z.string()).default([]),
  weightMethod: z.string().optional(),
  rebalanceFreq: z.string().optional(),
  asof: z.string().min(1),
  memoryTier: z.enum(["shallow", "intermediate", "deep"]).default("deep"),
});

export type StrategyRecipeMeta = z.infer<typeof StrategyRecipeMetaSchema>;

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

export function defaultTierForSubKind(subKind: string): MemoryTier {
  switch (subKind) {
    case "market_snapshot":
      return "shallow";
    case "research_conclusion":
    case "regime":
    case "pnl_episode":
    case "strategy_eval":
    case "postmortem":
      return "intermediate";
    case "factor_archive":
    case "strategy_recipe":
    case "playbook":
    case "execution_profile":
      return "deep";
    default:
      return "intermediate";
  }
}
