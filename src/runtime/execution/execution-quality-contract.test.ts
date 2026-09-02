import { describe, expect, test } from "bun:test";
import { assessExecutionQualityAgainstContract } from "./execution-quality-contract";

const metrics = {
  orderCount: 32,
  averageFillRatePct: 98,
  averageImplementationShortfallPct: 0.14,
  p95ImplementationShortfallPct: 0.31,
  averageSubmitLatencyMs: 80,
  p95TotalLatencyMs: 320,
  rejectionRatePct: 1,
};

const contract = {
  schemaVersion: 1 as const,
  calibrationId: "futu-us-equity-1d-2026q3",
  scope: { broker: "futu", assetClass: "equity", timeframe: "1d" },
  minOrderCount: 30,
  thresholds: {
    minAverageFillRatePct: 97,
    maxAverageImplementationShortfallPct: 0.2,
    maxP95ImplementationShortfallPct: 0.4,
    maxP95TotalLatencyMs: 500,
    maxRejectionRatePct: 2,
  },
};

describe("execution quality acceptance contract", () => {
  test("only evaluates a matching, adequately sampled calibration cohort", () => {
    const result = assessExecutionQualityAgainstContract({
      metrics,
      contract,
      runtimeScope: { broker: "futu", assetClass: "equity", timeframe: "1d" },
    });
    expect(result).toMatchObject({ status: "passed", pass: true, breaches: [] });

    expect(
      assessExecutionQualityAgainstContract({
        metrics: { ...metrics, orderCount: 29 },
        contract,
        runtimeScope: { broker: "futu", assetClass: "equity", timeframe: "1d" },
      })
    ).toMatchObject({ status: "insufficient_sample", pass: null });

    expect(
      assessExecutionQualityAgainstContract({
        metrics,
        contract,
        runtimeScope: { broker: "paper", assetClass: "equity", timeframe: "1d" },
      })
    ).toMatchObject({ status: "scope_mismatch", pass: null });
  });

  test("makes missing execution metrics and threshold breaches explicit", () => {
    const result = assessExecutionQualityAgainstContract({
      metrics: { ...metrics, averageFillRatePct: null, rejectionRatePct: 3 },
      contract,
      runtimeScope: { broker: "futu", assetClass: "equity", timeframe: "1d" },
    });
    expect(result).toMatchObject({ status: "failed", pass: false });
    expect(result.breaches).toEqual(
      expect.arrayContaining(["average_fill_rate_missing", "rejection_rate_above_threshold"])
    );
  });
});
