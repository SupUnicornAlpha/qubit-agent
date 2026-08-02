/**
 * Thin-loop Scenario Policy types (see AGENT_RUNTIME_QUALITY_AND_THIN_LOOP_PLAN).
 * DeliveryVerdict is independent of workflow_run lifecycle status.
 */

export type DeliveryState = "delivered" | "delivered_with_gaps" | "partial" | "failed";

export type DataGapClass = "unconfigured" | "no_coverage" | "no_data" | "infra_error";

export interface DeliveryVerdict {
  state: DeliveryState;
  reasonCodes: string[];
  /** Soft quality gaps (answer schema, underfill vs upgrade minRows). Do not block lifecycle. */
  softReasonCodes: string[];
  missingArtifacts: string[];
  missingCapabilities: string[];
  dataGaps: Array<{ capability: string; class: DataGapClass }>;
  answer: { schemaOk: boolean; missingSections: string[] };
  /**
   * Runtime lifecycle may complete when true (tools + research-floor artifacts).
   * Independent of upgrade-grade answer schema / full minRows.
   */
  researchOk: boolean;
  /** Full recipe contract including answer schema and upgrade minRows. */
  upgradeOk: boolean;
  evaluatorVersion: string;
  recipeKey: string | null;
  recipeVersion: string | null;
}

export interface ArtifactPredicate {
  table: string;
  /** Upgrade / promotion threshold. */
  minRows: number;
  /**
   * Research / lifecycle floor. Default 1.
   * 0 = optional for researchOk (still counted for upgradeOk via minRows).
   */
  researchMinRows?: number;
  requiredFields?: string[];
  scope: "workflow" | "project";
  /** Optional SQL override; when absent, CompletionEvaluator uses scenario-expectations. */
  countSql?: string;
}

export interface RequiredToolPredicate {
  capability: string;
  minSuccess: number;
}

export interface AnswerSchemaPredicate {
  requiredSections: string[];
  minChars?: number;
  /** Benchmark-only narrow asserts; not used for product DeliveryVerdict by default. */
  mustIncludeTerms?: string[];
}

export interface CompletionPredicate {
  artifacts: ArtifactPredicate[];
  requiredTools: RequiredToolPredicate[];
  answerSchema: AnswerSchemaPredicate;
  forbiddenFinalizeReasons?: string[];
}

export type StallBudgetKey = "tool" | "tool_market" | "tool_fingerprint";

export interface StallBudget {
  tools: string[];
  key: StallBudgetKey;
  maxSuccess: number;
  onExceed: "strip_from_surface" | "inject_recovery";
}

export interface DataGapRecovery {
  afterProbeFailure: "escalate_hitl" | "degrade_source" | "continue_without_realtime";
  forbidGapAsFinalAnswer: true;
}

export interface ScenarioRecipe {
  key: string;
  aliases: string[];
  version: string;
  capabilityOwners?: Record<string, string>;
  roleToolAllowlist?: Record<string, string[]>;
  stallBudget: StallBudget;
  recovery: DataGapRecovery;
  completion: CompletionPredicate;
  checklistPrompt: string[];
}

export interface RecoverySuggestion {
  mode: "hint_only" | "system_action";
  nextTool: string | null;
  missingParams: string[];
  hint: string;
  /** Draft params for the model — never silently dispatched for business writes. */
  draftParams?: Record<string, unknown>;
}

export const EVALUATOR_VERSION = "2026-08-02.1";

/** Business write tools that must never be silently dispatched by Recovery. */
export const BUSINESS_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "factor.register",
  "factor.compute",
  "factor.evaluate",
  "factor.autoEvaluate",
  "recommendation.record",
  "order.create_intent",
  "strategy.create_version",
  "strategy.compose",
  "backtest.run",
  "run_backtest",
  "run_screener",
]);
