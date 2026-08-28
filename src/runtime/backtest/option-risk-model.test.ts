import { describe, expect, test } from "bun:test";
import { calculateBlackScholesGreeks, yearsToExpiry } from "./option-risk-model";

describe("option risk model", () => {
  test("calculates stable European call Greeks", () => {
    const risk = calculateBlackScholesGreeks({
      right: "call",
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      impliedVolatility: 0.2,
      riskFreeRateAnnual: 0.05,
    });
    expect(risk).not.toBeNull();
    expect(risk?.theoreticalPrice).toBeCloseTo(10.4506, 3);
    expect(risk?.delta).toBeCloseTo(0.6368, 3);
    expect(risk?.gamma).toBeGreaterThan(0);
    expect(risk?.thetaPerDay).toBeLessThan(0);
    expect(risk?.vegaPerPoint).toBeGreaterThan(0);
  });

  test("refuses expired or incomplete inputs", () => {
    expect(
      calculateBlackScholesGreeks({
        right: "put",
        spot: 100,
        strike: 100,
        timeToExpiryYears: 0,
        impliedVolatility: 0.2,
        riskFreeRateAnnual: 0.05,
      })
    ).toBeNull();
    expect(yearsToExpiry("2026-01-02", "2026-01-01")).toBe(0);
  });
});
