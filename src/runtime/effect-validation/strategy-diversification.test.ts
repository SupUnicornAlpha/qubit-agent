import { describe, expect, test } from "bun:test";
import {
  assessStrategyDiversification,
  equityCurveToOosReturns,
  type OosReturnPoint,
} from "./strategy-diversification";

function returns(values: number[]): OosReturnPoint[] {
  return values.map((value, index) => ({
    timestamp: `2026-01-${String(index + 1).padStart(2, "0")}`,
    return: value,
  }));
}

describe("strategy diversification", () => {
  test("derives a reproducible return series from equity", () => {
    const result = equityCurveToOosReturns([
      { date: "2026-01-01", equity: 100 },
      { date: "2026-01-02", equity: 102 },
      { date: "2026-01-03", equity: 101 },
    ]);
    expect(result.map((point) => point.timestamp)).toEqual(["2026-01-02", "2026-01-03"]);
    expect(result[0]?.return).toBeCloseTo(0.02, 12);
    expect(result[1]?.return).toBeCloseTo(-1 / 102, 12);
  });

  test("rejects highly correlated OOS candidates", () => {
    const base = Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? 0.01 : -0.005));
    const result = assessStrategyDiversification({
      champion: returns(base),
      challenger: returns(base.map((value) => value * 1.1)),
      minimumObservations: 8,
    });
    expect(result.status).toBe("correlation_too_high");
    expect(result.pass).toBe(false);
  });

  test("accepts a low-correlated candidate only when the equal-weight portfolio improves", () => {
    const result = assessStrategyDiversification({
      champion: returns([0.02, -0.015, 0.018, -0.012, 0.02, -0.016, 0.017, -0.01]),
      challenger: returns([0.004, 0.005, 0.006, 0.004, 0.005, 0.006, 0.004, 0.005]),
      minimumObservations: 8,
      maxAbsCorrelation: 0.85,
    });
    expect(result.status).toBe("passed");
    expect(result.incrementalPeriodSharpe).toBeGreaterThanOrEqual(0);
  });

  test("fails closed on too few shared OOS timestamps", () => {
    const result = assessStrategyDiversification({
      champion: returns([0.01, -0.01]),
      challenger: returns([0.01, -0.01]),
      minimumObservations: 3,
    });
    expect(result.status).toBe("insufficient_evidence");
  });

  test("permanently excludes ambiguous duplicate timestamps", () => {
    const champion = returns([0.01, -0.01, 0.02, -0.02]);
    const challenger = [
      ...returns([0.004, 0.005, 0.006, 0.007]),
      { timestamp: "2026-01-02", return: 0.99 },
      { timestamp: "2026-01-02", return: -0.99 },
    ];
    const result = assessStrategyDiversification({
      champion,
      challenger,
      minimumObservations: 4,
    });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.pairedObservations).toBe(3);
  });
});
