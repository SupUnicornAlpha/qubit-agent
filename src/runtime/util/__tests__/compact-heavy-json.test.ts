import { describe, expect, test } from "bun:test";
import { compactBacktestResult, compactHeavyJson } from "../compact-heavy-json";

describe("compactHeavyJson", () => {
  test("collapses equityCurve / trades arrays", () => {
    const out = compactHeavyJson({
      id: "bt-1",
      result: {
        metrics: { sharpe: 1.2 },
        equityCurve: Array.from({ length: 200 }, (_, i) => ({ date: `d${i}`, equity: i })),
        trades: Array.from({ length: 100 }, () => ({ side: "buy" })),
      },
    }) as {
      result: {
        metrics: { sharpe: number };
        equityCurve: { __compact: boolean; length: number };
        trades: { __compact: boolean; length: number };
      };
    };
    expect(out.result.metrics.sharpe).toBe(1.2);
    expect(out.result.equityCurve).toEqual({ __compact: true, length: 200 });
    expect(out.result.trades).toEqual({ __compact: true, length: 100 });
  });

  test("compactBacktestResult keeps metrics only series stubs", () => {
    const out = compactBacktestResult({
      metrics: { sharpe: 2 },
      equityCurve: [{ date: "a", equity: 1 }],
      trades: [{ side: "sell" }],
      meta: { engine: "x" },
    }) as {
      metrics: { sharpe: number };
      equityCurve: { length: number };
      trades: { length: number };
      meta: { engine: string };
    };
    expect(out.metrics.sharpe).toBe(2);
    expect(out.equityCurve.length).toBe(1);
    expect(out.trades.length).toBe(1);
    expect(out.meta.engine).toBe("x");
  });
});
