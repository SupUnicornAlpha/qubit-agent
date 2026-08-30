import { describe, expect, test } from "bun:test";
import { assessInvestmentFrameworkCandidate } from "./investment-framework-assessment";

const card = {
  version: "investment-framework-card-v1" as const,
  framework: "quality_growth" as const,
  sourceRefs: ["source:framework"],
  principles: [{ statement: "Quality compounds.", sourceRefs: ["source:framework"] }],
  economicMechanism: "High returns and reinvestment can compound capital.",
  observableProxies: [
    { key: "roic", label: "ROIC", comparison: "gte" as const, threshold: 0.15, weight: 2, sourceRefs: ["source:framework"] },
    { key: "net_debt_ebitda", label: "Net debt/EBITDA", comparison: "lte" as const, threshold: 2, weight: 1, sourceRefs: ["source:framework"] },
  ],
  selectionThreshold: 0.8,
  applicability: { assetClasses: ["equity"], markets: ["US"], regimes: ["normal"], holdingPeriod: "12m" },
  exclusionConditions: ["Financial statements are not available."],
  invalidation: [{ condition: "ROIC falls", observable: "fund_roic" }],
  riskBudget: { maxPositionWeightPct: 0.1, maxPortfolioDrawdownPct: 0.15 },
};

describe("investment framework assessment", () => {
  test("qualifies only complete, evidence-backed observations that meet the declared rules", () => {
    const result = assessInvestmentFrameworkCandidate(card, {
      symbol: "US:ACME",
      assetClass: "equity",
      market: "US",
      regime: "normal",
      observations: {
        roic: { value: 0.2, evidenceRefs: ["fundamental:roic:2026q2"] },
        net_debt_ebitda: { value: 1.5, evidenceRefs: ["fundamental:debt:2026q2"] },
      },
    });
    expect(result).toMatchObject({ status: "qualified", score: 1, coverage: 1 });
  });

  test("missing evidence stays research-only; regime mismatch is rejected", () => {
    const missing = assessInvestmentFrameworkCandidate(card, {
      symbol: "US:ACME",
      assetClass: "equity",
      market: "US",
      regime: "normal",
      observations: {
        roic: { value: 0.2, evidenceRefs: [] },
        net_debt_ebitda: { value: 1.5, evidenceRefs: ["fundamental:debt:2026q2"] },
      },
    });
    expect(missing.status).toBe("research_only");
    const mismatch = assessInvestmentFrameworkCandidate(card, {
      symbol: "US:ACME",
      assetClass: "equity",
      market: "US",
      regime: "risk_off",
      observations: {
        roic: { value: 0.2, evidenceRefs: ["fundamental:roic:2026q2"] },
        net_debt_ebitda: { value: 1.5, evidenceRefs: ["fundamental:debt:2026q2"] },
      },
    });
    expect(mismatch).toMatchObject({ status: "rejected" });
    expect(mismatch.reasons).toContain("regime_outside_framework:risk_off");
  });

  test("scope mismatch is rejected even when the remaining evidence is incomplete", () => {
    const result = assessInvestmentFrameworkCandidate(card, {
      symbol: "US:ACME",
      assetClass: "equity",
      market: "US",
      regime: "stress",
      observations: {},
    });
    expect(result.status).toBe("rejected");
    expect(result.reasons).toContain("regime_outside_framework:stress");
    expect(result.reasons).toContain("framework_observation_or_evidence_incomplete");
  });
});
