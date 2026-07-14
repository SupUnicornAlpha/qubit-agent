import { describe, expect, test } from "bun:test";
import { buildStrategyConsistencyReport } from "./strategy-consistency-service";

describe("strategy stage consistency", () => {
  test("flags paper/live drift outside tolerance", () => {
    const base = { pass: true, qualityScore: 0.8, createdAt: "2026-07-14T00:00:00Z" };
    const rows = [
      { ...base, id: "b", evalKind: "backtest", metricsJson: { netReturn: 0.1, sharpe: 1 } },
      { ...base, id: "p", evalKind: "paper", metricsJson: { netReturn: 0.09, sharpe: 0.9 } },
      { ...base, id: "l", evalKind: "live", metricsJson: { netReturn: 0.04, sharpe: 0.4 } },
    ] as never;
    const report = buildStrategyConsistencyReport(rows, 0.25);
    expect(report.missingStages).toEqual([]);
    expect(report.pass).toBe(false);
    expect(report.comparisons.some((item) => !item.pass)).toBe(true);
  });
});
