import { describe, expect, test } from "bun:test";
import type { BacktestRequest } from "../provider/types";
import { buildBacktestIntegrityReport } from "./anti-leakage-report";

function request(
  qualification: BacktestRequest["dataset"]["qualification"],
  parameterSelection: NonNullable<BacktestRequest["experiment"]>["parameterSelection"] = "unknown"
): BacktestRequest {
  return {
    strategyVersionId: "strategy-v1",
    dataset: {
      snapshotId: "snapshot-1",
      dataRef: "sha256:data",
      asOf: "2026-01-31T00:00:00.000Z",
      timeframe: "1d",
      sourceIds: ["fixture"],
      barsBySymbol: {},
      qualification,
    },
    signals: { kind: "factor_score", factorId: "f1", expr: "close", lang: "qlib_expr" },
    universe: "US",
    symbols: ["AAA"],
    startDate: "2025-01-01",
    endDate: "2025-12-31",
    capital: 100_000,
    costs: {
      commissionBps: 5,
      slippageBps: 5,
      costModelVersion: "fixture-fees-v1",
      costModelSource: "fixture_exchange_schedule",
      costModelAsOf: "2025-01-01T00:00:00.000Z",
    },
    experiment: { parameterSelection },
  };
}

function validationRequest(
  parameterSelection: NonNullable<BacktestRequest["experiment"]>["parameterSelection"]
): BacktestRequest {
  return request(
    {
      useClass: "strategy_validation",
      universeHistory: "verified",
      corporateActions: "verified",
      pointInTime: "verified",
      limitations: [],
    },
    parameterSelection
  );
}

describe("machine-readable anti-leakage report", () => {
  test("missing universe/corporate-action/OOS evidence remains research_only", () => {
    const report = buildBacktestIntegrityReport(
      request({
        useClass: "research_only",
        universeHistory: "not_verified",
        corporateActions: "not_verified",
        pointInTime: "verified",
        limitations: ["universe_history_not_verified"],
      }),
      { runtimeDataIsolated: true, nextBarExecution: true }
    );
    expect(report.status).toBe("research_only");
    expect(report.unknownChecks).toContain("survivorship_bias");
    expect(report.unknownChecks).toContain("oos_isolation");
    expect(report.inputFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("validation dataset + frozen params + purged walk-forward can pass", () => {
    const report = buildBacktestIntegrityReport(
      request(
        {
          useClass: "strategy_validation",
          universeHistory: "verified",
          corporateActions: "verified",
          pointInTime: "verified",
          limitations: [],
        },
        "fixed_before_run"
      ),
      {
        runtimeDataIsolated: true,
        nextBarExecution: true,
        oos: { mode: "walk_forward", foldCount: 3, purgeDays: 5, embargoDays: 5 },
      }
    );
    expect(report.status).toBe("passed");
    expect(report.failedChecks).toEqual([]);
    expect(report.unknownChecks).toEqual([]);
  });

  test("full-sample optimization is explicitly rejected", () => {
    const report = buildBacktestIntegrityReport(
      request(
        {
          useClass: "strategy_validation",
          universeHistory: "verified",
          corporateActions: "verified",
          pointInTime: "verified",
          limitations: [],
        },
        "full_sample_optimized"
      ),
      {
        runtimeDataIsolated: true,
        nextBarExecution: true,
        oos: { mode: "walk_forward", foldCount: 3, purgeDays: 5, embargoDays: 5 },
      }
    );
    expect(report.status).toBe("rejected");
    expect(report.failedChecks).toContain("parameter_selection");
  });

  test("zero-friction or unpriced shorting assumptions stay unknown", () => {
    const zeroFriction = validationRequest("fixed_before_run");
    zeroFriction.costs = { commissionBps: 0, slippageBps: 0 };
    const zeroReport = buildBacktestIntegrityReport(zeroFriction, {
      runtimeDataIsolated: true,
      nextBarExecution: true,
      oos: { mode: "walk_forward", foldCount: 3, purgeDays: 5, embargoDays: 5 },
    });
    expect(zeroReport.unknownChecks).toContain("transaction_costs");

    const short = validationRequest("fixed_before_run");
    short.longShort = true;
    const shortReport = buildBacktestIntegrityReport(short, {
      runtimeDataIsolated: true,
      nextBarExecution: true,
      oos: { mode: "walk_forward", foldCount: 3, purgeDays: 5, embargoDays: 5 },
    });
    expect(shortReport.unknownChecks).toContain("transaction_costs");
  });

  test("unversioned or default cost assumptions cannot become validation evidence", () => {
    const missingProvenance = validationRequest("fixed_before_run");
    missingProvenance.costs = { commissionBps: 5, slippageBps: 5 };
    const report = buildBacktestIntegrityReport(missingProvenance, {
      runtimeDataIsolated: true,
      nextBarExecution: true,
      oos: { mode: "walk_forward", foldCount: 3, purgeDays: 5, embargoDays: 5 },
    });

    expect(report.status).toBe("research_only");
    expect(report.unknownChecks).toContain("transaction_costs");
  });

  test("purge without an explicit embargo remains research-only", () => {
    const report = buildBacktestIntegrityReport(validationRequest("fixed_before_run"), {
      runtimeDataIsolated: true,
      nextBarExecution: true,
      oos: { mode: "walk_forward", foldCount: 3, purgeDays: 5 },
    });
    expect(report.status).toBe("research_only");
    expect(report.unknownChecks).toContain("embargo_isolation");
  });
});
