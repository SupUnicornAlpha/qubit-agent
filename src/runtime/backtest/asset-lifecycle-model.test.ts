import { describe, expect, test } from "bun:test";
import type { BacktestRequest } from "../provider/types";
import {
  buildAssetLifecycleReport,
  exposureToQuantity,
  fundingCashFlow,
  normalizeInstrument,
} from "./asset-lifecycle-model";

function request(instruments: BacktestRequest["instruments"]): BacktestRequest {
  return {
    dataset: {
      snapshotId: "snapshot",
      dataRef: "ref",
      asOf: "2026-01-01T00:00:00Z",
      timeframe: "1d",
      sourceIds: ["fixture"],
      barsBySymbol: {},
      qualification: {
        useClass: "research_only",
        universeHistory: "not_verified",
        corporateActions: "not_verified",
        pointInTime: "verified",
        limitations: [],
      },
    },
    signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
    universe: "mixed",
    symbols: Object.keys(instruments ?? { AAPL: {} }),
    instruments,
    startDate: "2026-01-01",
    endDate: "2026-02-01",
    capital: 100_000,
    costs: { commissionBps: 0, slippageBps: 0 },
  };
}

describe("asset lifecycle model", () => {
  test("fails closed when an option contract is incomplete", () => {
    const report = buildAssetLifecycleReport(
      request({
        "AAPL-C": {
          assetClass: "option",
          contractMultiplier: 100,
          settlementMode: "cash",
        },
      })
    );
    expect(report.status).toBe("invalid");
    expect(report.checks.some((check) => check.code === "option_expiryDate_required")).toBe(true);
  });

  test("accepts a cash-settled European option but exposes the model limitation", () => {
    const report = buildAssetLifecycleReport(
      request({
        "AAPL-C": {
          assetClass: "option",
          contractMultiplier: 100,
          expiryDate: "2026-01-30",
          settlementMode: "cash",
          underlyingSymbol: "AAPL",
          strike: 200,
          optionRight: "call",
          exerciseStyle: "european",
        },
      })
    );
    expect(report.status).toBe("research_only");
    expect(report.checks.every((check) => check.state !== "fail")).toBe(true);
  });

  test("applies multiplier and lot size when converting exposure", () => {
    const spec = normalizeInstrument("ES", {
      ES: { assetClass: "future", contractMultiplier: 50, lotSize: 1 },
    });
    expect(exposureToQuantity(1_000_000, 5_000, spec)).toBe(4);
  });

  test("requires frozen initial and maintenance margin for futures", () => {
    const report = buildAssetLifecycleReport(
      request({
        ES: {
          assetClass: "future",
          contractMultiplier: 50,
          expiryDate: "2026-03-20",
          settlementMode: "cash",
        },
      })
    );
    expect(report.status).toBe("invalid");
    expect(report.checks.some((check) => check.code === "future_initial_margin_required")).toBe(
      true
    );
    expect(report.checks.some((check) => check.code === "future_maintenance_margin_required")).toBe(
      true
    );
  });

  test("fails closed when a futures roll successor is absent from the frozen contract table", () => {
    const report = buildAssetLifecycleReport(
      request({
        ESH6: {
          assetClass: "future",
          contractMultiplier: 50,
          expiryDate: "2026-03-20",
          settlementMode: "cash",
          initialMarginRate: 0.1,
          maintenanceMarginRate: 0.08,
          futureRoll: { rollDate: "2026-03-14", successorSymbol: "ESM6" },
        },
      })
    );

    expect(report.status).toBe("invalid");
    expect(report.checks.some((check) => check.code === "future_roll_successor_missing")).toBe(
      true
    );
  });

  test("fails closed when the roll successor is not in the frozen backtest universe", () => {
    const input = request({
      ESH6: {
        assetClass: "future",
        contractMultiplier: 50,
        expiryDate: "2026-03-20",
        settlementMode: "cash",
        initialMarginRate: 0.1,
        maintenanceMarginRate: 0.08,
        futureRoll: { rollDate: "2026-03-14", successorSymbol: "ESM6" },
      },
      ESM6: {
        assetClass: "future",
        contractMultiplier: 50,
        expiryDate: "2026-06-19",
        settlementMode: "cash",
        initialMarginRate: 0.1,
        maintenanceMarginRate: 0.08,
      },
    });
    input.symbols = ["ESH6"];

    const report = buildAssetLifecycleReport(input);

    expect(report.status).toBe("invalid");
    expect(
      report.checks.some((check) => check.code === "future_roll_successor_not_in_universe")
    ).toBe(true);
  });

  test("fails closed when a futures roll chain forms a cycle", () => {
    const report = buildAssetLifecycleReport(
      request({
        ESH6: {
          assetClass: "future",
          contractMultiplier: 50,
          expiryDate: "2026-03-20",
          settlementMode: "cash",
          initialMarginRate: 0.1,
          maintenanceMarginRate: 0.08,
          futureRoll: { rollDate: "2026-03-14", successorSymbol: "ESM6" },
        },
        ESM6: {
          assetClass: "future",
          contractMultiplier: 50,
          expiryDate: "2026-06-19",
          settlementMode: "cash",
          initialMarginRate: 0.1,
          maintenanceMarginRate: 0.08,
          futureRoll: { rollDate: "2026-06-13", successorSymbol: "ESH6" },
        },
      })
    );

    expect(report.status).toBe("invalid");
    expect(report.checks.some((check) => check.code === "future_roll_cycle")).toBe(true);
  });

  test("marks missing tradability fields as a research-only limitation", () => {
    const report = buildAssetLifecycleReport(request({ AAPL: { assetClass: "stock" } }));

    expect(report.status).toBe("research_only");
    expect(report.checks.some((check) => check.code === "tradability_flags_missing")).toBe(true);
  });

  test("accepts explicit tradability plus frozen calendar provenance", () => {
    const input = request({ AAPL: { assetClass: "stock" } });
    input.dataset.barsBySymbol.AAPL = [
      {
        timestamp: "2026-01-02T14:30:00.000Z",
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 1_000,
        turnover: 100_000,
        tradable: true,
      },
    ];
    input.dataset.tradingCalendar = {
      version: "NYSE-2026.1",
      timezone: "America/New_York",
      sessionsBySymbol: { AAPL: { "2026-01-02": "open" } },
    };

    const report = buildAssetLifecycleReport(input);

    expect(report.status).toBe("passed");
    expect(report.checks.some((check) => check.code === "calendar_provenance_valid")).toBe(true);
  });

  test("positive perpetual funding debits longs and credits shorts", () => {
    const spec = normalizeInstrument("BTC-PERP", {
      "BTC-PERP": { assetClass: "crypto", contractKind: "perpetual" },
    });
    expect(fundingCashFlow(2, 50_000, 1, spec)).toBe(-10);
    expect(fundingCashFlow(-2, 50_000, 1, spec)).toBe(10);
  });
});
