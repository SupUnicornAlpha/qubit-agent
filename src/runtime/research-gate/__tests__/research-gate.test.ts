import { describe, expect, test } from "bun:test";
import { collectSampleStatsFromRows } from "../../research-dataset";
import {
  assessResearchSampleGate,
  assertCrossSectionIcComputeAllowed,
  CROSS_SECTION_IC_HARD_MINIMUM_SYMBOLS,
  resolveResearchRunContract,
} from "../index";

describe("research-run-contract", () => {
  test("resolves factor_research defaults", () => {
    const c = resolveResearchRunContract({ scenarioKey: "factor_research" });
    expect(c.intent).toBe("factor");
    expect(c.dataset.minSymbols).toBe(60);
    expect(c.dataset.minTradingDays).toBe(504);
    expect(c.promotion.allowFromResearchOnly).toBe(false);
  });

  test("intent single_name overrides dataset floor", () => {
    const c = resolveResearchRunContract({
      scenarioKey: "factor_research",
      intent: "single_name",
    });
    expect(c.intent).toBe("single_name");
    expect(c.dataset.minSymbols).toBe(1);
  });
});

describe("sample-gate", () => {
  test("marks research_only when below factor thresholds", () => {
    const contract = resolveResearchRunContract({ scenarioKey: "factor_research" });
    const gate = assessResearchSampleGate({
      contract,
      sampleStats: { nSymbols: 8, nTradingDays: 120, nBars: 960 },
      hasDatasetSnapshot: true,
      hasPreprocessSpec: true,
    });
    expect(gate.okForPromotion).toBe(false);
    expect(gate.grade).toBe("research_only");
    expect(gate.allowCrossSectionIcCompute).toBe(true);
    expect(gate.missing.some((m) => m.startsWith("min_symbols"))).toBe(true);
  });

  test("bans IC promotion for single_name even with many bars", () => {
    const contract = resolveResearchRunContract({ intent: "single_name" });
    const gate = assessResearchSampleGate({
      contract,
      sampleStats: { nSymbols: 1, nTradingDays: 500, nBars: 500 },
      hasDatasetSnapshot: true,
    });
    expect(gate.banCrossSectionIcPromotion).toBe(true);
    expect(gate.okForPromotion).toBe(false);
    expect(() =>
      assertCrossSectionIcComputeAllowed({ intent: "single_name", nSymbols: 1 })
    ).toThrow(/cross_section_ic_banned_for_intent/);
  });

  test("hard minimum symbols for IC compute", () => {
    expect(() =>
      assertCrossSectionIcComputeAllowed({ intent: "factor", nSymbols: 2 })
    ).toThrow(/cross_section_too_few_symbols/);
    expect(() =>
      assertCrossSectionIcComputeAllowed({
        intent: "factor",
        nSymbols: CROSS_SECTION_IC_HARD_MINIMUM_SYMBOLS,
      })
    ).not.toThrow();
  });

  test("collectSampleStatsFromRows", () => {
    const stats = collectSampleStatsFromRows([
      { symbol: "A", date: "2024-01-02" },
      { symbol: "B", date: "2024-01-02" },
      { symbol: "A", date: "2024-01-03" },
    ]);
    expect(stats.nSymbols).toBe(2);
    expect(stats.nTradingDays).toBe(2);
    expect(stats.nBars).toBe(3);
  });
});
