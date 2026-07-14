import { describe, expect, test } from "bun:test";
import type { BarData } from "../../connectors/data/data.connector";
import {
  type DecisionSignalForEvaluation,
  evaluateDecisionSignal,
  evaluationHorizons,
} from "./recommendation-outcome-evaluator";

function signal(overrides: Partial<DecisionSignalForEvaluation> = {}): DecisionSignalForEvaluation {
  return {
    id: "rec-1",
    symbol: "AAPL",
    market: "US",
    side: "long",
    horizonDays: 2,
    asof: "2026-01-01T23:00:00.000Z",
    entryLow: null,
    entryHigh: null,
    stopLoss: 95,
    takeProfit: 110,
    benchmarkSymbol: "SPY",
    expiresAt: null,
    ...overrides,
  };
}

function bars(values: Array<[string, number, number, number, number]>): BarData[] {
  return values.map(([timestamp, open, high, low, close]) => ({
    symbol: "AAPL",
    exchange: "US",
    timestamp,
    open,
    high,
    low,
    close,
    volume: 100,
    turnover: 0,
  }));
}

const forwardBars = bars([
  ["2026-01-02T00:00:00.000Z", 100, 103, 99, 101],
  ["2026-01-05T00:00:00.000Z", 101, 111, 100, 109],
  ["2026-01-06T00:00:00.000Z", 109, 112, 108, 111],
]);

describe("evaluateDecisionSignal", () => {
  test("evaluates standard horizons and preserves custom primary horizon", () => {
    expect(evaluationHorizons(20)).toEqual([1, 5, 20, 60]);
    expect(evaluationHorizons(10)).toEqual([1, 5, 10, 20, 60]);
  });

  test("long recommendation exits at take profit", () => {
    const result = evaluateDecisionSignal(signal(), forwardBars);
    expect(result.kind).toBe("evaluated");
    if (result.kind !== "evaluated") return;
    expect(result.exitReason).toBe("take_profit");
    expect(result.exitPrice).toBe(110);
    expect(result.returnPct).toBeCloseTo(8.9109, 3);
    expect(result.outcome).toBe("win");
  });

  test("same bar stop and target uses conservative stop-first policy", () => {
    const result = evaluateDecisionSignal(
      signal({ horizonDays: 1, stopLoss: 95, takeProfit: 105 }),
      bars([
        ["2026-01-02T00:00:00.000Z", 100, 106, 94, 100],
        ["2026-01-05T00:00:00.000Z", 100, 101, 99, 100],
      ])
    );
    expect(result.kind).toBe("evaluated");
    if (result.kind !== "evaluated") return;
    expect(result.ambiguousBar).toBe(true);
    expect(result.exitReason).toBe("stop_loss");
    expect(result.returnPct).toBe(-5);
  });

  test("short recommendation reverses price return", () => {
    const result = evaluateDecisionSignal(
      signal({ side: "short", horizonDays: 1, stopLoss: 106, takeProfit: 94 }),
      bars([
        ["2026-01-02T00:00:00.000Z", 100, 101, 99, 100],
        ["2026-01-05T00:00:00.000Z", 99, 100, 93, 94],
      ])
    );
    expect(result.kind).toBe("evaluated");
    if (result.kind !== "evaluated") return;
    expect(result.exitReason).toBe("take_profit");
    expect(result.returnPct).toBe(6);
  });

  test("insufficient forward bars remains pending", () => {
    const result = evaluateDecisionSignal(signal({ horizonDays: 5 }), forwardBars);
    expect(result).toEqual({
      kind: "not_ready",
      barsObserved: 3,
      reason: "insufficient_forward_bars",
    });
  });
});
