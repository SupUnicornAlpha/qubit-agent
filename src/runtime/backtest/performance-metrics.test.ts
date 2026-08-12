import { describe, expect, test } from "bun:test";
import { computePerformanceMetrics } from "./performance-metrics";

describe("computePerformanceMetrics", () => {
  test("calculates risk, tail and benchmark-relative metrics from a shared equity curve", () => {
    const metrics = computePerformanceMetrics({
      initialCapital: 100,
      equityCurve: [
        { equity: 100, benchmarkEquity: 100 },
        { equity: 104, benchmarkEquity: 102 },
        { equity: 100, benchmarkEquity: 100 },
        { equity: 106, benchmarkEquity: 103 },
        { equity: 102, benchmarkEquity: 101 },
      ],
      trades: [
        { qty: 1, price: 100, commission: 0.1 },
        { qty: 1, price: 102, commission: 0.1 },
      ],
    });

    expect(metrics.totalReturn).toBeCloseTo(0.02, 8);
    expect(metrics.maxDrawdown).toBeCloseTo(4 / 104, 8);
    expect(metrics.conditionalValueAtRisk95).toBeGreaterThan(0);
    expect(Number.isFinite(metrics.sortino)).toBe(true);
    expect(metrics.turnover).toBeGreaterThan(0);
    expect(metrics.totalCommission).toBeCloseTo(0.2, 8);
    expect(metrics.benchmark?.beta).toBeGreaterThan(1.9);
    expect(metrics.benchmark?.beta).toBeLessThan(2.1);
    expect(metrics.benchmark?.correlation).toBeGreaterThan(0.999);
    expect(metrics.benchmark?.informationRatio).toBeGreaterThan(0);
  });

  test("returns finite zero-safe values for a short or flat curve", () => {
    const metrics = computePerformanceMetrics({
      initialCapital: 100,
      equityCurve: [{ equity: 100 }],
    });
    for (const value of Object.values(metrics)) {
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
    }
    expect(metrics.benchmark).toBeNull();
  });
});
