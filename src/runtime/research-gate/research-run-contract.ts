/**
 * Scenario / turn-level research discipline contract (code gate, not prompt).
 * @see docs/RESEARCH_DATASET_GATE_EVOLUTION.md §B
 */
import { z } from "zod";

export const ResearchRunIntentSchema = z.enum([
  "factor",
  "strategy",
  "thesis_only",
  "single_name",
]);
export type ResearchRunIntent = z.infer<typeof ResearchRunIntentSchema>;

export const ResearchRunContractSchema = z.object({
  version: z.literal("research-run-contract-v1"),
  scenarioKey: z.string().trim().min(1),
  intent: ResearchRunIntentSchema,
  dataset: z.object({
    minSymbols: z.number().int().min(1),
    minTradingDays: z.number().int().min(1),
    requirePIT: z.boolean(),
    requirePreprocess: z.boolean(),
  }),
  pathChoice: z.object({
    requireHitlSingleChoiceWhenMultiplePaths: z.boolean(),
  }),
  promotion: z.object({
    allowFromResearchOnly: z.literal(false),
  }),
});

export type ResearchRunContract = z.infer<typeof ResearchRunContractSchema>;

/** Absolute floor to compute a daily cross-sectional IC at all. */
export const CROSS_SECTION_IC_HARD_MINIMUM_SYMBOLS = 3;

const FACTOR_DEFAULT: ResearchRunContract = {
  version: "research-run-contract-v1",
  scenarioKey: "factor_research",
  intent: "factor",
  dataset: {
    minSymbols: 60,
    minTradingDays: 504,
    requirePIT: true,
    requirePreprocess: true,
  },
  pathChoice: { requireHitlSingleChoiceWhenMultiplePaths: true },
  promotion: { allowFromResearchOnly: false },
};

const STRATEGY_DEFAULT: ResearchRunContract = {
  ...FACTOR_DEFAULT,
  scenarioKey: "strategy_authoring",
  intent: "strategy",
};

const SINGLE_NAME_DEFAULT: ResearchRunContract = {
  version: "research-run-contract-v1",
  scenarioKey: "single_name",
  intent: "single_name",
  dataset: {
    minSymbols: 1,
    minTradingDays: 252,
    requirePIT: true,
    requirePreprocess: false,
  },
  pathChoice: { requireHitlSingleChoiceWhenMultiplePaths: true },
  promotion: { allowFromResearchOnly: false },
};

const THESIS_DEFAULT: ResearchRunContract = {
  version: "research-run-contract-v1",
  scenarioKey: "conversational_research",
  intent: "thesis_only",
  dataset: {
    minSymbols: 1,
    minTradingDays: 1,
    requirePIT: false,
    requirePreprocess: false,
  },
  pathChoice: { requireHitlSingleChoiceWhenMultiplePaths: true },
  promotion: { allowFromResearchOnly: false },
};

/** Default contracts keyed by research scenario (no DB migration in P0). */
export const DEFAULT_RESEARCH_RUN_CONTRACTS: Record<string, ResearchRunContract> = {
  factor_research: FACTOR_DEFAULT,
  strategy_authoring: STRATEGY_DEFAULT,
  strategy: STRATEGY_DEFAULT,
  single_name: SINGLE_NAME_DEFAULT,
  conversational_research: THESIS_DEFAULT,
};

export function parseResearchRunContract(value: unknown): ResearchRunContract | null {
  const parsed = ResearchRunContractSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function resolveResearchRunContract(input: {
  scenarioKey?: string | null;
  intent?: ResearchRunIntent | null;
  override?: Partial<ResearchRunContract> | null;
}): ResearchRunContract {
  const key = input.scenarioKey?.trim() || "";
  const fromScenario = key ? DEFAULT_RESEARCH_RUN_CONTRACTS[key] : undefined;
  let base: ResearchRunContract =
    fromScenario ??
    (input.intent === "single_name"
      ? SINGLE_NAME_DEFAULT
      : input.intent === "thesis_only"
        ? THESIS_DEFAULT
        : input.intent === "strategy"
          ? STRATEGY_DEFAULT
          : FACTOR_DEFAULT);

  if (input.intent && input.intent !== base.intent) {
    base = {
      ...base,
      intent: input.intent,
      ...(input.intent === "single_name"
        ? {
            dataset: {
              ...SINGLE_NAME_DEFAULT.dataset,
            },
          }
        : {}),
    };
  }

  if (!input.override) return base;
  const merged = {
    ...base,
    ...input.override,
    dataset: { ...base.dataset, ...(input.override.dataset ?? {}) },
    pathChoice: { ...base.pathChoice, ...(input.override.pathChoice ?? {}) },
    promotion: { allowFromResearchOnly: false as const },
    version: "research-run-contract-v1" as const,
  };
  const parsed = ResearchRunContractSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
}
