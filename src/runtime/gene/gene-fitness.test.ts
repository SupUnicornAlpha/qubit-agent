import { describe, expect, test } from "bun:test";
import { scoreGenomeFitness } from "./gene-fitness";

const soundMetrics = {
  annualReturn: 0.18,
  sharpe: 1.2,
  sortino: 1.8,
  calmar: 1.1,
  maxDrawdown: 0.16,
  conditionalValueAtRisk95: 0.035,
  turnover: 4,
  positivePeriodRate: 0.54,
  maxConsecutiveLosses: 4,
  tradeCount: 20,
  benchmark: {
    totalReturn: 0.1,
    annualReturn: 0.1,
    beta: 0.8,
    alpha: 0.06,
    correlation: 0.7,
    informationRatio: 0.8,
    trackingError: 0.1,
    upCapture: 1.1,
    downCapture: 0.8,
    observations: 120,
  },
};

describe("scoreGenomeFitness", () => {
  test("allows a sufficiently sampled, balanced strategy into the parent pool", () => {
    const result = scoreGenomeFitness({ metrics: soundMetrics, sampleSize: 252 });
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThan(60);
    expect(result.dimensions.risk).toBeGreaterThan(50);
  });

  test("does not allow a high-Sharpe but tail-risky or under-sampled strategy to evolve", () => {
    const result = scoreGenomeFitness({
      metrics: { ...soundMetrics, conditionalValueAtRisk95: 0.12, maxDrawdown: 0.38 },
      sampleSize: 30,
    });
    expect(result.eligible).toBe(false);
    expect(result.failedGates).toContain("sample_size_below_60");
    expect(result.failedGates).toContain("cvar95_above_0.08");
    expect(result.failedGates).toContain("max_drawdown_above_0.3");
  });
});
