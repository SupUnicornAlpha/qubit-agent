/**
 * Research contract for a factor that is allowed to influence a strategy.
 *
 * This is deliberately a small, storage-agnostic module: the contract is
 * stored in factor_definition.definition_json, but validation and eligibility
 * logic do not depend on SQLite or a provider implementation.
 */
import { z } from "zod";

const RequiredText = z.string().trim().min(1);

export const FactorResearchContractSchema = z.object({
  version: z.literal("factor-research-contract-v1"),
  economicMechanism: RequiredText,
  dataAvailability: z.object({
    sourceFields: z.array(RequiredText).min(1),
    availableAtRule: RequiredText,
    pointInTime: z.literal(true),
  }),
  formula: z.object({
    /** Must be the exact executable expression registered for the factor. */
    expression: RequiredText,
    frequency: RequiredText,
    expectedDirection: z.enum(["higher_is_bullish", "lower_is_bullish", "non_monotonic"]),
  }),
  preprocessing: z.object({
    missingValuePolicy: z.enum(["drop", "median_impute", "zero_impute", "carry_forward"]),
    winsorization: RequiredText,
    standardization: RequiredText,
    neutralization: RequiredText,
  }),
  applicability: z.object({
    universes: z.array(RequiredText).min(1),
    horizonsDays: z.array(z.number().int().positive()).min(1),
    invalidationConditions: z.array(RequiredText).min(1),
  }),
  validation: z.object({
    independentValidationPlan: RequiredText,
    minimumDailyObservations: z.number().int().min(60),
  }),
});

export type FactorResearchContract = z.infer<typeof FactorResearchContractSchema>;

export function parseFactorResearchContract(value: unknown): FactorResearchContract | null {
  const parsed = FactorResearchContractSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whitespace-insensitive equality still disallows a narrative formula mismatch. */
export function researchContractMatchesExpression(
  contract: FactorResearchContract,
  expression: string
): boolean {
  const compact = (value: string) => value.replace(/\s+/g, "");
  return compact(contract.formula.expression) === compact(expression);
}
