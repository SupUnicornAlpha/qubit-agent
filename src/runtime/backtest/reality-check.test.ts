import { describe, expect, test } from "bun:test";
import type { BacktestEquityPoint } from "../provider/types";
import { buildWhiteRealityCheck } from "./reality-check";

function equity(id: string, count: number, dailyReturn: (index: number) => number) {
  let value = 100;
  const curve: BacktestEquityPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    if (index > 0) value *= 1 + dailyReturn(index);
    curve.push({ date: `day-${String(index).padStart(4, "0")}`, equity: value });
  }
  return { id, equityCurve: curve };
}

describe("White Reality Check", () => {
  test("passes a candidate family with data-snooping-adjusted superiority", () => {
    const report = buildWhiteRealityCheck(
      [
        equity("edge", 180, (index) => 0.001 + (index % 7 === 0 ? -0.0004 : 0.0001)),
        equity("flat", 180, (index) => (index % 2 === 0 ? 0.0002 : -0.0002)),
        equity("weak", 180, (index) => 0.00005 + (index % 3 === 0 ? -0.0002 : 0.0001)),
      ],
      { simulations: 400 }
    );
    expect(report.status).toBe("passed");
    expect(report.bestCandidateId).toBe("edge");
    expect(report.pValue).toBeLessThanOrEqual(0.05);
  });

  test("does not promote a zero-mean candidate family", () => {
    const report = buildWhiteRealityCheck(
      [
        equity("alternating-a", 180, (index) => (index % 2 === 0 ? 0.001 : -0.001)),
        equity("alternating-b", 180, (index) => (index % 4 < 2 ? 0.0005 : -0.0005)),
      ],
      { simulations: 300 }
    );
    expect(report.status).toBe("research_only");
    expect(report.pValue).toBeGreaterThan(0.05);
  });

  test("is deterministic and fail-closed on short samples", () => {
    const candidates = [
      equity("a", 20, () => 0.001),
      equity("b", 20, () => 0.0005),
    ];
    const first = buildWhiteRealityCheck(candidates, { simulations: 200 });
    expect(buildWhiteRealityCheck(candidates, { simulations: 200 })).toEqual(first);
    expect(first.status).toBe("research_only");
    expect(first.checks.find((check) => check.key === "minimum_sample")?.state).toBe("unknown");
  });

  test("uses embedded benchmark returns instead of crediting market beta", () => {
    const market = equity("market-like", 180, (index) => 0.001 + (index % 5 === 0 ? -0.0002 : 0));
    market.equityCurve = market.equityCurve.map((point) => ({
      ...point,
      benchmarkEquity: point.equity,
    }));
    const slightlyWorse = equity("slightly-worse", 180, (index) =>
      0.0009 + (index % 5 === 0 ? -0.0002 : 0)
    );
    slightlyWorse.equityCurve = slightlyWorse.equityCurve.map((point, index) => ({
      ...point,
      benchmarkEquity: market.equityCurve[index]!.equity,
    }));
    const report = buildWhiteRealityCheck([market, slightlyWorse], { simulations: 300 });
    expect(report.benchmark).toBe("backtest_benchmark");
    expect(report.status).toBe("research_only");
  });
});
