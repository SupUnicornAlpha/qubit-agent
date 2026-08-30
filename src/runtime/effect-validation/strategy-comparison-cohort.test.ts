import { describe, expect, test } from "bun:test";
import {
  buildStrategyComparisonCohort,
  readStrategyComparisonCohortId,
} from "./strategy-comparison-cohort";

const base = {
  dataset: {
    snapshotId: "mkt_snapshot_comparison",
    dataRef: "data_ref_comparison",
    asOf: "2026-08-29T00:00:00.000Z",
    timeframe: "1d",
    sourceIds: ["frozen-source"],
    barsBySymbol: {},
    qualification: {
      useClass: "strategy_validation" as const,
      universeHistory: "verified" as const,
      corporateActions: "verified" as const,
      pointInTime: "verified" as const,
      limitations: [],
    },
  },
  startDate: "2024-01-01",
  endDate: "2025-12-31",
  symbols: ["MSFT", "AAPL"],
  universe: "US-LIQUID",
  benchmark: "SPY",
  costs: { commissionBps: 3, slippageBps: 4 },
};

describe("strategy comparison cohort", () => {
  test("is stable across symbol order and excludes strategy-specific settings", () => {
    const left = buildStrategyComparisonCohort(base);
    const right = buildStrategyComparisonCohort({ ...base, symbols: ["AAPL", "MSFT"] });
    expect(left.id).toBe(right.id);
    expect(readStrategyComparisonCohortId({ comparisonCohort: left })).toBe(left.id);
  });

  test("changes when a frozen input that affects comparability changes", () => {
    const baseId = buildStrategyComparisonCohort(base).id;
    expect(
      buildStrategyComparisonCohort({
        ...base,
        dataset: { ...base.dataset, snapshotId: "mkt_snapshot_other" },
      }).id
    ).not.toBe(baseId);
    expect(buildStrategyComparisonCohort({ ...base, endDate: "2026-01-31" }).id).not.toBe(baseId);
    expect(readStrategyComparisonCohortId({ comparisonCohort: { id: "untrusted" } })).toBeNull();
  });
});
