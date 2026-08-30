import {
  type InvestmentFrameworkCard,
  InvestmentFrameworkCardSchema,
} from "./market-event-v2";

export type FrameworkCandidateInput = {
  symbol: string;
  assetClass: string;
  market: string;
  regime: string;
  observations: Record<string, { value: number | null; evidenceRefs: string[] }>;
};

export type FrameworkCandidateAssessment = {
  symbol: string;
  status: "qualified" | "rejected" | "research_only";
  score: number | null;
  coverage: number;
  proxyChecks: Array<{
    key: string;
    value: number | null;
    passed: boolean | null;
    weight: number;
    evidenceRefs: string[];
    reason?: string;
  }>;
  reasons: string[];
  riskBudget: InvestmentFrameworkCard["riskBudget"];
};

/**
 * Deterministic rule evaluation for framework-backed screening. Every numeric
 * observation must have an evidence reference; missing values never become a
 * pass and framework/regime mismatch never becomes a buy recommendation.
 */
export function assessInvestmentFrameworkCandidate(
  rawCard: InvestmentFrameworkCard,
  candidate: FrameworkCandidateInput
): FrameworkCandidateAssessment {
  const card = InvestmentFrameworkCardSchema.parse(rawCard);
  const reasons: string[] = [];
  if (!card.applicability.assetClasses.includes(candidate.assetClass)) {
    reasons.push(`asset_class_outside_framework:${candidate.assetClass}`);
  }
  if (!card.applicability.markets.includes(candidate.market)) {
    reasons.push(`market_outside_framework:${candidate.market}`);
  }
  if (!card.applicability.regimes.includes(candidate.regime)) {
    reasons.push(`regime_outside_framework:${candidate.regime}`);
  }

  const totalWeight = card.observableProxies.reduce((sum, proxy) => sum + proxy.weight, 0);
  let passedWeight = 0;
  let observedWeight = 0;
  const proxyChecks = card.observableProxies.map((proxy) => {
    const observation = candidate.observations[proxy.key];
    const value = observation?.value ?? null;
    const evidenceRefs = observation?.evidenceRefs ?? [];
    if (value === null || !Number.isFinite(value)) {
      return {
        key: proxy.key,
        value: null,
        passed: null,
        weight: proxy.weight,
        evidenceRefs,
        reason: "observation_missing",
      };
    }
    if (evidenceRefs.length === 0) {
      return {
        key: proxy.key,
        value,
        passed: null,
        weight: proxy.weight,
        evidenceRefs,
        reason: "observation_evidence_missing",
      };
    }
    observedWeight += proxy.weight;
    const passed = proxy.comparison === "gte" ? value >= proxy.threshold : value <= proxy.threshold;
    if (passed) passedWeight += proxy.weight;
    return { key: proxy.key, value, passed, weight: proxy.weight, evidenceRefs };
  });
  const coverage = totalWeight > 0 ? observedWeight / totalWeight : 0;
  const score = totalWeight > 0 ? passedWeight / totalWeight : null;
  if (coverage < 1) reasons.push("framework_observation_or_evidence_incomplete");
  if (score !== null && score < card.selectionThreshold) reasons.push("framework_score_below_threshold");
  const scopeMismatch = reasons.some((reason) =>
    reason.startsWith("asset_class_outside_framework:") ||
    reason.startsWith("market_outside_framework:") ||
    reason.startsWith("regime_outside_framework:")
  );
  const status =
    scopeMismatch
      ? "rejected"
      : coverage < 1
      ? "research_only"
      : reasons.length === 0
        ? "qualified"
        : "rejected";
  return {
    symbol: candidate.symbol,
    status,
    score,
    coverage,
    proxyChecks,
    reasons,
    riskBudget: card.riskBudget,
  };
}
