import { describe, expect, test } from "bun:test";
import { allocatePortfolio } from "./portfolio-allocation-service";

describe("allocatePortfolio", () => {
  test("enforces position, sector and total risk budgets", () => {
    const plan = allocatePortfolio([
      { symbol: "AAA", side: "long", price: 100, stopLoss: 90, confidence: 0.9, sector: "Tech" },
      { symbol: "BBB", side: "long", price: 50, stopLoss: 45, confidence: 0.8, sector: "Tech" },
      { symbol: "CCC", side: "short", price: 80, stopLoss: 88, confidence: 0.7, sector: "Energy" },
    ], {
      capital: 100_000,
      grossLimit: 1,
      netLimit: 0.25,
      perPositionMax: 0.3,
      maxSectorGross: 0.4,
      totalRiskBudget: 0.03,
    });
    expect(plan.rows.every((row) => Math.abs(row.targetWeight) <= 0.3)).toBe(true);
    expect(plan.exposures.sectorGross.Tech).toBeLessThanOrEqual(0.4);
    expect(plan.exposures.estimatedLossAtStopsPct).toBeLessThanOrEqual(0.03);
    expect(Math.abs(plan.exposures.netExposure)).toBeLessThanOrEqual(0.25);
  });

  test("returns target quantities, rebalance and factor exposures", () => {
    const plan = allocatePortfolio([
      {
        symbol: "AAPL",
        side: "long",
        price: 200,
        stopLoss: 180,
        confidence: 0.8,
        currentQty: 10,
        beta: 1.2,
        styleExposures: { growth: 0.7 },
        factorExposures: { momentum: 0.5 },
      },
    ], { capital: 100_000, totalRiskBudget: 0.02 });
    expect(plan.rows[0]!.targetQty).toBe(100);
    expect(plan.rows[0]!.rebalanceQty).toBe(90);
    expect(plan.exposures.portfolioBeta).toBe(0.24);
    expect(plan.exposures.style.growth).toBe(0.14);
    expect(plan.exposures.factor.momentum).toBe(0.1);
  });

  test("computes weighted pair correlation", () => {
    const plan = allocatePortfolio([
      { symbol: "AAA", side: "long", price: 100, confidence: 1 },
      { symbol: "BBB", side: "long", price: 100, confidence: 1 },
    ], {
      capital: 10_000,
      correlationMatrix: { AAA: { BBB: 0.65 } },
    });
    expect(plan.exposures.weightedAverageCorrelation).toBe(0.65);
  });
});
