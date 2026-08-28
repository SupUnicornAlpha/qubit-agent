import { describe, expect, test } from "bun:test";
import { verifyPointInTimeIntegrity } from "./pit-verifier";
import type { BacktestDataset } from "../provider/types";

describe("Point-In-Time (PIT) Verifier", () => {
  test("should pass clean dataset without look-ahead bias", () => {
    const dataset: BacktestDataset = {
      snapshotId: "snap-001",
      dataRef: "market_snapshot/snap-001",
      asOf: "2026-04-30T23:59:59.999Z",
      timeframe: "1d",
      sourceIds: ["us_equity"],
      barsBySymbol: {
        AAPL: [
          {
            timestamp: "2026-04-01T00:00:00Z",
            open: 150,
            high: 155,
            low: 149,
            close: 154,
            volume: 1000000,
            turnover: 154000000,
          },
          {
            timestamp: "2026-04-02T00:00:00Z",
            open: 154,
            high: 158,
            low: 153,
            close: 157,
            volume: 1200000,
            turnover: 188400000,
          },
        ],
      },
      qualification: {
        useClass: "strategy_validation",
        universeHistory: "verified",
        corporateActions: "verified",
        pointInTime: "verified",
        limitations: [],
      },
    };

    const report = verifyPointInTimeIntegrity(dataset);
    expect(report.pass).toBe(true);
    expect(report.verdict).toBe("point_in_time_clean");
    expect(report.lookAheadRiskScore).toBe(0);
    expect(report.totalBarsAudited).toBe(2);
    expect(report.anomalyCount).toBe(0);
  });

  test("should detect future data leakage beyond asOf boundary", () => {
    const dataset: BacktestDataset = {
      snapshotId: "snap-002",
      dataRef: "market_snapshot/snap-002",
      asOf: "2026-04-01T23:59:59.999Z",
      timeframe: "1d",
      sourceIds: ["us_equity"],
      barsBySymbol: {
        AAPL: [
          {
            timestamp: "2026-04-01T00:00:00Z",
            open: 150,
            high: 155,
            low: 149,
            close: 154,
            volume: 1000000,
            turnover: 154000000,
          },
          {
            timestamp: "2026-04-05T00:00:00Z", // Future relative to asOf
            open: 160,
            high: 165,
            low: 159,
            close: 164,
            volume: 1000000,
            turnover: 164000000,
          },
        ],
      },
      qualification: {
        useClass: "research_only",
        universeHistory: "not_verified",
        corporateActions: "not_verified",
        pointInTime: "not_verified",
        limitations: [],
      },
    };

    const report = verifyPointInTimeIntegrity(dataset);
    expect(report.pass).toBe(false);
    expect(report.verdict).toBe("point_in_time_violated");
    expect(report.violations.some((v) => v.type === "future_data_leakage")).toBe(true);
  });

  test("should catch non-monotonic timestamps and invalid OHLC bounds", () => {
    const dataset: BacktestDataset = {
      snapshotId: "snap-003",
      dataRef: "market_snapshot/snap-003",
      asOf: "2026-04-30T23:59:59.999Z",
      timeframe: "1d",
      sourceIds: ["us_equity"],
      barsBySymbol: {
        TSLA: [
          {
            timestamp: "2026-04-02T00:00:00Z",
            open: 200,
            high: 190, // invalid high < open
            low: 180,
            close: 195,
            volume: 500000,
            turnover: 100000000,
          },
          {
            timestamp: "2026-04-01T00:00:00Z", // non-monotonic
            open: 190,
            high: 195,
            low: 185,
            close: 192,
            volume: 500000,
            turnover: 95000000,
          },
        ],
      },
      qualification: {
        useClass: "research_only",
        universeHistory: "not_verified",
        corporateActions: "not_verified",
        pointInTime: "not_verified",
        limitations: [],
      },
    };

    const report = verifyPointInTimeIntegrity(dataset);
    expect(report.pass).toBe(false);
    expect(report.violations.some((v) => v.type === "non_monotonic_timestamp")).toBe(true);
    expect(report.violations.some((v) => v.type === "invalid_ohlcv_bounds")).toBe(true);
  });

  test("automatically audits corporate actions projected from the frozen dataset ledger", () => {
    const dataset: BacktestDataset = {
      snapshotId: "snap-corporate-action",
      dataRef: "market_snapshot/snap-corporate-action",
      asOf: "2026-04-30T23:59:59.999Z",
      timeframe: "1d",
      sourceIds: ["validated_feed"],
      barsBySymbol: {
        AAPL: [
          {
            timestamp: "2026-04-01T00:00:00Z",
            open: 150,
            high: 155,
            low: 149,
            close: 154,
            volume: 1_000_000,
            turnover: 154_000_000,
          },
        ],
      },
      corporateActionEvents: [
        {
          symbol: "AAPL",
          effectiveDate: "2026-04-01",
          knownAt: "2026-04-02T12:00:00.000Z",
          kind: "split",
        },
      ],
      qualification: {
        useClass: "strategy_validation",
        universeHistory: "verified",
        corporateActions: "verified",
        pointInTime: "verified",
        limitations: [],
      },
    };

    const report = verifyPointInTimeIntegrity(dataset);

    expect(report.pass).toBe(false);
    expect(report.verdict).toBe("point_in_time_violated");
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "corporate_action_pre_announcement", symbol: "AAPL" }),
      ])
    );
  });

  test("rejects a fundamental revision that was unavailable at the snapshot boundary", () => {
    const dataset: BacktestDataset = {
      snapshotId: "snap-fundamental-revision",
      dataRef: "market_snapshot/snap-fundamental-revision",
      asOf: "2026-04-30T23:59:59.999Z",
      timeframe: "1d",
      sourceIds: ["validated_feed"],
      barsBySymbol: {
        AAPL: [
          {
            timestamp: "2026-04-01T00:00:00Z",
            open: 150,
            high: 155,
            low: 149,
            close: 154,
            volume: 1_000_000,
            turnover: 154_000_000,
          },
        ],
      },
      fundamentalObservations: [
        {
          symbol: "AAPL",
          metric: "revenue_ttm",
          fiscalPeriodEnd: "2026-03-31",
          availableAt: "2026-05-01T12:00:00.000Z",
          value: 100,
        },
      ],
      qualification: {
        useClass: "strategy_validation",
        universeHistory: "verified",
        corporateActions: "verified",
        pointInTime: "verified",
        limitations: [],
      },
    };

    const report = verifyPointInTimeIntegrity(dataset);
    expect(report.pass).toBe(false);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "fundamental_observation_after_asof", symbol: "AAPL" }),
      ])
    );
  });

  test("clean chronology without verified provenance remains degraded", () => {
    const dataset: BacktestDataset = {
      snapshotId: "snap-unverified",
      dataRef: "market_snapshot/snap-unverified",
      asOf: "2026-04-30T23:59:59.999Z",
      timeframe: "1d",
      sourceIds: ["research_feed"],
      barsBySymbol: {
        AAPL: [
          {
            timestamp: "2026-04-01T00:00:00Z",
            open: 10,
            high: 11,
            low: 9,
            close: 10,
            volume: 100,
            turnover: 1_000,
          },
        ],
      },
      qualification: {
        useClass: "research_only",
        universeHistory: "not_verified",
        corporateActions: "not_verified",
        pointInTime: "not_verified",
        limitations: ["point_in_time_not_verified"],
      },
    };
    const report = verifyPointInTimeIntegrity(dataset);
    expect(report.pass).toBe(false);
    expect(report.verdict).toBe("point_in_time_degraded");
    expect(report.violations.some((item) => item.type === "pit_provenance_unverified")).toBe(true);
  });
});
