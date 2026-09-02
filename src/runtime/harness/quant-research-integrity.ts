/**
 * Product-owned policy adapter for the quant research integrity loop.
 *
 * It deliberately has no database, provider or prompt dependency. The
 * underlying evidence remains owned by the existing snapshot, backtest,
 * walk-forward, paper-evaluation and promotion services. Keeping this
 * adapter pure makes it safe to load per workflow and easy to remove without
 * leaving a second source of truth behind.
 */
export const QUANT_RESEARCH_INTEGRITY_CAPABILITY_ID = "quant.research-integrity";

export type QuantResearchIntegrityStage = "research" | "paper" | "live";

export type QuantResearchIntegrityEvidence = {
  validationQualifiedDataset: boolean;
  backtestIntegrity: boolean;
  factorRiskExposure: boolean;
  walkForward: boolean;
  finalHoldout: boolean;
  paper: boolean;
  humanApproval: boolean;
};

export type QuantResearchIntegrityAssessment = {
  capabilityId: typeof QUANT_RESEARCH_INTEGRITY_CAPABILITY_ID;
  stage: QuantResearchIntegrityStage;
  /** Research reports gaps but is not an execution permission. */
  enforcement: "advisory" | "required";
  passed: boolean;
  requiredChecks: Array<keyof QuantResearchIntegrityEvidence>;
  missingChecks: Array<keyof QuantResearchIntegrityEvidence>;
};

export const QUANT_RESEARCH_INTEGRITY_CHECK_TITLES: Record<
  keyof QuantResearchIntegrityEvidence,
  string
> = {
  validationQualifiedDataset: "验证级数据集快照",
  backtestIntegrity: "回测完整性",
  factorRiskExposure: "因子风险暴露",
  walkForward: "Walk-Forward OOS",
  finalHoldout: "一次性 final holdout",
  paper: "Paper 同 cohort 证据",
  humanApproval: "人工批准",
};

export const REQUIREMENTS: Record<
  QuantResearchIntegrityStage,
  Array<keyof QuantResearchIntegrityEvidence>
> = {
  // Research remains useful when evidence is incomplete, but its gaps must be
  // visible and it never grants paper or live execution permission.
  research: ["validationQualifiedDataset", "backtestIntegrity"],
  // A paper result may be collected while still exploratory. It can only be
  // used as promotion evidence when the frozen backtest and OOS gates exist.
  paper: [
    "validationQualifiedDataset",
    "backtestIntegrity",
    "factorRiskExposure",
    "walkForward",
    "paper",
  ],
  // Live is intentionally stronger: human approval is additive, not a
  // substitute for the historical and paper evidence.
  live: [
    "validationQualifiedDataset",
    "backtestIntegrity",
    "factorRiskExposure",
    "walkForward",
    "finalHoldout",
    "paper",
    "humanApproval",
  ],
};

export function assessQuantResearchIntegrity(input: {
  stage: QuantResearchIntegrityStage;
  evidence: QuantResearchIntegrityEvidence;
}): QuantResearchIntegrityAssessment {
  const requiredChecks = REQUIREMENTS[input.stage];
  const missingChecks = requiredChecks.filter((key) => !input.evidence[key]);
  return {
    capabilityId: QUANT_RESEARCH_INTEGRITY_CAPABILITY_ID,
    stage: input.stage,
    enforcement: input.stage === "research" ? "advisory" : "required",
    passed: missingChecks.length === 0,
    requiredChecks: [...requiredChecks],
    missingChecks,
  };
}

export function listQuantResearchIntegrityStages(): Array<{
  stage: QuantResearchIntegrityStage;
  enforcement: "advisory" | "required";
  checks: Array<{ id: keyof QuantResearchIntegrityEvidence; title: string }>;
}> {
  return (["research", "paper", "live"] as const).map((stage) => ({
    stage,
    enforcement: stage === "research" ? "advisory" : "required",
    checks: REQUIREMENTS[stage].map((id) => ({
      id,
      title: QUANT_RESEARCH_INTEGRITY_CHECK_TITLES[id],
    })),
  }));
}
