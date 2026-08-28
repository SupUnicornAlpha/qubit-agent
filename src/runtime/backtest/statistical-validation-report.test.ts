import { describe, expect, test } from "bun:test";
import type { BacktestRequest } from "../provider/types";
import {
  benjaminiHochberg,
  buildStatisticalValidationReport,
} from "./statistical-validation-report";

function request(candidateTrials?: number): BacktestRequest {
  return {
    strategyVersionId: "strategy-v1",
    dataset: {
      snapshotId: "snapshot-v1",
      dataRef: "sha256:test",
      asOf: "2026-01-01T00:00:00Z",
      timeframe: "1d",
      sourceIds: ["test"],
      barsBySymbol: {},
      qualification: {
        useClass: "strategy_validation",
        universeHistory: "verified",
        corporateActions: "verified",
        pointInTime: "verified",
        limitations: [],
      },
    },
    signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
    universe: "US",
    symbols: ["AAA"],
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    capital: 100_000,
    costs: { commissionBps: 5, slippageBps: 5 },
    experiment: {
      parameterSelection: "fixed_before_run",
      ...(candidateTrials !== undefined ? { candidateTrials } : {}),
    },
  };
}

function equity(count: number, dailyReturn: number) {
  let value = 100_000;
  return Array.from({ length: count }, (_, index) => {
    if (index > 0) value *= 1 + dailyReturn + (index % 5 === 0 ? -0.0002 : 0.0001);
    return { date: `2025-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`, equity: value };
  });
}

describe("statistical validation report", () => {
  test("undeclared trial count remains research-only", () => {
    const report = buildStatisticalValidationReport(request(), equity(100, 0.001));
    expect(report.status).toBe("research_only");
    expect(report.checks.find((item) => item.key === "trial_count_declared")?.state).toBe("unknown");
  });

  test("positive long sample passes adjusted bootstrap confidence", () => {
    const report = buildStatisticalValidationReport(request(4), equity(180, 0.001), {
      simulations: 300,
      trialAnnualizedSharpes: [0.1, 0.2, 0.15, 0.25],
    });
    expect(report.status).toBe("passed");
    expect(report.adjustedAlpha).toBe(0.0125);
    expect(report.sharpeConfidenceInterval?.lower).toBeGreaterThan(0);
    expect(report.bonferroniAdjustedPValue).not.toBeNull();
    expect(report.checks.find((item) => item.key === "multiple_testing")?.state).toBe("pass");
    expect(report.deflatedSharpe?.probability).toBeGreaterThanOrEqual(0.95);
    expect(report.deflatedSharpe?.benchmarkAnnualizedSharpe).toBeGreaterThan(0.24);
    expect(report.deflatedSharpe?.benchmarkAnnualizedSharpe).toBeLessThan(0.25);
    expect(report.checks.find((item) => item.key === "deflated_sharpe")?.state).toBe("pass");
  });

  test("report is deterministic for the same experiment", () => {
    const first = buildStatisticalValidationReport(request(2), equity(120, 0.0005), {
      simulations: 200,
    });
    const second = buildStatisticalValidationReport(request(2), equity(120, 0.0005), {
      simulations: 200,
    });
    expect(second).toEqual(first);
  });

  test("multiple trials without their Sharpe distribution remain research-only", () => {
    const report = buildStatisticalValidationReport(request(5), equity(180, 0.001), {
      simulations: 300,
    });
    expect(report.deflatedSharpe).toBeNull();
    expect(report.checks.find((item) => item.key === "deflated_sharpe")?.state).toBe("unknown");
    expect(report.status).toBe("research_only");
  });

  test("Benjamini-Hochberg controls a declared candidate family", () => {
    const report = benjaminiHochberg([
      { id: "a", pValue: 0.004 },
      { id: "b", pValue: 0.02 },
      { id: "c", pValue: 0.4 },
      { id: "missing", pValue: null },
    ]);
    expect(report.method).toBe("benjamini_hochberg");
    expect(report.hypothesisCount).toBe(4);
    expect(report.discoveryCount).toBe(2);
    expect(report.hypotheses.find((item) => item.id === "a")?.adjustedPValue).toBe(0.016);
    expect(report.hypotheses.find((item) => item.id === "missing")?.pass).toBe(false);
  });
});
