import { describe, expect, test } from "bun:test";
import type { BacktestRequest } from "../../types";
import { EventDrivenBacktestProvider } from "./event-driven-backtest-provider";
import { runEventEngine } from "./event-engine";

const bars = (base: number) =>
  [0, 1, 2, 3].map((offset) => ({
    timestamp: `2026-01-0${offset + 2}T00:00:00.000Z`,
    open: base + offset,
    high: base + offset + 2,
    low: base + offset - 1,
    close: base + offset + 1,
    volume: 1_000,
    turnover: (base + offset + 1) * 1_000,
  }));

describe("EventDrivenBacktestProvider", () => {
  test("settles a delisted holding from the frozen corporate-action ledger and never reopens it", () => {
    const barsByDate = new Map(
      ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"].map((date) => [
        date,
        new Map([["AAA", { open: 100, high: 101, low: 99, close: 100, volume: 10_000 }]]),
      ])
    );
    const signals = new Map(
      ["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"].map((date) => [
        date,
        new Map([["AAA", 1]]),
      ])
    );

    const result = runEventEngine({
      dates: [...barsByDate.keys()],
      bars: barsByDate,
      signals,
      capital: 1_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
      delistings: [{ symbol: "AAA", effectiveDate: "2026-01-04", cashAmount: 40 }],
    });

    expect(result.trades).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-01-03", symbol: "AAA", side: "buy" }),
        expect.objectContaining({ date: "2026-01-04", symbol: "AAA", side: "sell", price: 40 }),
      ])
    );
    expect(result.trades.filter((trade) => trade.symbol === "AAA")).toHaveLength(2);
    expect(result.meta.assetLifecycleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "delisting_settlement", symbol: "AAA" }),
      ])
    );
  });

  test("runs entirely from the immutable bound dataset", async () => {
    const request: BacktestRequest = {
      strategyVersionId: "strategy-v1",
      dataset: {
        snapshotId: "mkt_snapshot_fixture",
        dataRef: "obs_fixture",
        asOf: "2026-01-05T23:59:59.000Z",
        timeframe: "1d",
        sourceIds: ["fixture"],
        qualification: {
          useClass: "research_only",
          universeHistory: "not_verified",
          corporateActions: "raw_unadjusted",
          pointInTime: "verified",
          limitations: ["fixture"],
        },
        barsBySymbol: { AAA: bars(100), BBB: bars(200) },
      },
      signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
      universe: "US",
      symbols: ["AAA", "BBB"],
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      capital: 100_000,
      costs: { commissionBps: 5, slippageBps: 5 },
      topN: 1,
    };

    const result = await new EventDrivenBacktestProvider().run(request);

    expect(result.error).toBeUndefined();
    expect(result.meta.barCount).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.meta.antiLeakageReport?.status).toBe("research_only");
    expect(result.meta.pitReport).toMatchObject({
      pass: true,
      verdict: "point_in_time_clean",
    });
    expect(result.meta.statisticalValidationReport?.status).toBe("research_only");
    expect(
      result.meta.antiLeakageReport?.checks.find((check) => check.key === "signal_fill_separation")
        ?.state
    ).toBe("pass");
  });

  test("combines a multi-factor composition from the same snapshot", async () => {
    const request: BacktestRequest = {
      strategyVersionId: "strategy-v2",
      dataset: {
        snapshotId: "mkt_snapshot_fixture",
        dataRef: "obs_fixture",
        asOf: "2026-01-05T23:59:59.000Z",
        timeframe: "1d",
        sourceIds: ["fixture"],
        qualification: {
          useClass: "research_only",
          universeHistory: "not_verified",
          corporateActions: "raw_unadjusted",
          pointInTime: "verified",
          limitations: ["fixture"],
        },
        barsBySymbol: { AAA: bars(100), BBB: bars(200) },
      },
      signals: {
        kind: "factor_composite",
        factors: [
          { factorId: "factor-close", expr: "close", lang: "qlib_expr", weight: 1 },
          { factorId: "factor-volume", expr: "volume", lang: "qlib_expr", weight: 0 },
        ],
      },
      universe: "US",
      symbols: ["AAA", "BBB"],
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      topN: 1,
    };

    const result = await new EventDrivenBacktestProvider().run(request);

    expect(result.error).toBeUndefined();
    expect(result.trades.find((trade) => trade.side === "buy")?.symbol).toBe("BBB");
  });

  test("fails closed before execution when derivative contract metadata is incomplete", async () => {
    const request: BacktestRequest = {
      strategyVersionId: "strategy-option",
      dataset: {
        snapshotId: "mkt_snapshot_fixture",
        dataRef: "obs_fixture",
        asOf: "2026-01-05T23:59:59.000Z",
        timeframe: "1d",
        sourceIds: ["fixture"],
        qualification: {
          useClass: "research_only",
          universeHistory: "not_verified",
          corporateActions: "raw_unadjusted",
          pointInTime: "verified",
          limitations: ["fixture"],
        },
        barsBySymbol: { OPT: bars(10) },
      },
      signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
      universe: "US-OPTION",
      symbols: ["OPT"],
      instruments: {
        OPT: { assetClass: "option", contractMultiplier: 100 },
      },
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
    };

    const result = await new EventDrivenBacktestProvider().run(request);

    expect(result.error).toContain("asset_lifecycle_invalid");
    expect(result.trades).toEqual([]);
    expect(result.meta.assetLifecycleReport?.status).toBe("invalid");
  });

  test("rejects intraday snapshots instead of collapsing multiple bars into one daily event", async () => {
    const request: BacktestRequest = {
      strategyVersionId: "strategy-intraday",
      dataset: {
        snapshotId: "mkt_snapshot_intraday_fixture",
        dataRef: "obs_intraday_fixture",
        asOf: "2026-01-05T23:59:59.000Z",
        timeframe: "5m",
        sourceIds: ["fixture"],
        qualification: {
          useClass: "research_only",
          universeHistory: "not_verified",
          corporateActions: "raw_unadjusted",
          pointInTime: "verified",
          limitations: ["fixture"],
        },
        barsBySymbol: {
          AAA: [
            {
              timestamp: "2026-01-05T14:30:00.000Z",
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 1_000,
              turnover: 100_000,
            },
            {
              timestamp: "2026-01-05T14:35:00.000Z",
              open: 101,
              high: 102,
              low: 100,
              close: 101,
              volume: 1_000,
              turnover: 101_000,
            },
          ],
        },
      },
      signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
      universe: "US",
      symbols: ["AAA"],
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
    };

    const result = await new EventDrivenBacktestProvider().run(request);

    expect(result.error).toBe("intraday_timeframe_not_supported:5m");
    expect(result.trades).toEqual([]);
    expect(result.equityCurve).toEqual([]);
  });
});
