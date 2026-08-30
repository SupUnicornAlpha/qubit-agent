import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMarketSnapshotRecord,
  clearMarketSnapshotCatalogForTests,
} from "../market/contracts/market-snapshot-service";
import { bindBacktestDataset } from "./dataset-snapshot-binding";

afterEach(() => clearMarketSnapshotCatalogForTests());

describe("dataset snapshot calendar binding", () => {
  test("projects venue sessions onto the requested symbol without guessing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-calendar-bind-"));
    const priorDataDir = process.env.QUBIT_DATA_DIR;
    process.env.QUBIT_DATA_DIR = dataDir;
    try {
      const record = buildMarketSnapshotRecord({
        asOf: "2026-01-03T00:00:00.000Z",
        purpose: "backtest",
        instruments: [{ symbol: "AAPL", venue: "US", assetClass: "equity" }],
        window: { start: "2026-01-02T00:00:00.000Z", end: "2026-01-03T00:00:00.000Z" },
        sources: [
          {
            provider: "fixture",
            feed: "public_aggregate",
            upstreamFamily: "fixture",
            feedClass: "L0_research_fallback",
            licenseUse: "research_only",
          },
        ],
        barsByInstrument: {
          "US:AAPL": [
            {
              timestamp: "2026-01-02T00:00:00.000Z",
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 1_000,
              turnover: 100_000,
            },
          ],
        },
        timeframe: "1d",
        limit: 10,
        timezone: "America/New_York",
        calendarVersion: "NYSE-2026.1",
        calendarSessionsByVenue: { US: { "2026-01-02": "open", "2026-01-03": "closed" } },
        calendarSessionWindowsByVenue: {
          US: {
            "2026-01-02": [
              {
                openAt: "2026-01-02T14:30:00.000Z",
                closeAt: "2026-01-02T21:00:00.000Z",
              },
            ],
          },
        },
      });
      const root = join(dataDir, "market-snapshots");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${record.snapshot.snapshotId}.json`), JSON.stringify(record));

      const dataset = await bindBacktestDataset({
        snapshotId: record.snapshot.snapshotId,
        symbols: ["AAPL"],
        startDate: "2026-01-02",
        endDate: "2026-01-03",
      });

      expect(dataset.tradingCalendar).toEqual({
        version: "NYSE-2026.1",
        timezone: "America/New_York",
        sessionsBySymbol: { AAPL: { "2026-01-02": "open", "2026-01-03": "closed" } },
        sessionWindowsBySymbol: {
          AAPL: {
            "2026-01-02": [
              {
                openAt: "2026-01-02T14:30:00.000Z",
                closeAt: "2026-01-02T21:00:00.000Z",
              },
            ],
          },
        },
      });
      expect(dataset.qualification.useClass).toBe("research_only");
      expect(dataset.qualification.limitations).toEqual(
        expect.arrayContaining([
          "universe_history_not_verified",
          "corporate_actions_not_versioned",
          "validation_feed_not_verified",
        ])
      );
    } finally {
      if (priorDataDir === undefined) process.env.QUBIT_DATA_DIR = undefined;
      else process.env.QUBIT_DATA_DIR = priorDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("admits validation-grade history only when frozen membership and corporate-action ledgers cover every symbol", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-history-bind-"));
    const priorDataDir = process.env.QUBIT_DATA_DIR;
    process.env.QUBIT_DATA_DIR = dataDir;
    try {
      const record = buildMarketSnapshotRecord({
        asOf: "2026-01-03T00:00:00.000Z",
        purpose: "backtest",
        instruments: [{ symbol: "AAPL", venue: "US", assetClass: "equity" }],
        window: { start: "2026-01-02T00:00:00.000Z", end: "2026-01-03T00:00:00.000Z" },
        sources: [
          {
            provider: "validated_fixture",
            feed: "licensed_history",
            upstreamFamily: "fixture",
            feedClass: "L1_strategy_validation",
            licenseUse: "research_only",
          },
        ],
        barsByInstrument: {
          "US:AAPL": [
            {
              timestamp: "2026-01-02T00:00:00.000Z",
              open: 100,
              high: 101,
              low: 99,
              close: 100,
              volume: 1_000,
              turnover: 100_000,
            },
          ],
        },
        timeframe: "1d",
        limit: 10,
        adjustMethod: "none",
        universeHistory: {
          universeId: "sp500",
          version: "sp500-2026.01",
          source: "fixture_universe_archive",
          asOf: "2026-01-03T00:00:00.000Z",
          membershipIntervals: [{ symbol: "AAPL", startDate: "2025-01-01" }],
        },
        corporateActionLedger: {
          version: "corp-actions-2026.01",
          source: "fixture_corporate_actions",
          asOf: "2026-01-03T00:00:00.000Z",
          adjustmentMethod: "none",
          actionsBySymbol: {
            AAPL: [
              {
                kind: "cash_dividend",
                effectiveDate: "2026-01-02",
                knownAt: "2026-01-01T12:00:00.000Z",
              },
            ],
          },
        },
        fundamentalLedger: {
          version: "fundamentals-2026.01",
          source: "fixture_filings",
          asOf: "2026-01-03T00:00:00.000Z",
          observationsBySymbol: {
            AAPL: [
              {
                metric: "revenue_ttm",
                fiscalPeriodEnd: "2025-12-31",
                availableAt: "2026-01-01T12:00:00.000Z",
                value: 100,
                revisionId: "filing-r1",
              },
            ],
          },
        },
        derivativePricingLedger: {
          version: "us-options-iv-2026.01",
          source: "fixture_options_vendor",
          asOf: "2026-01-03T00:00:00.000Z",
          impliedVolatilityMethod: "market_quote",
          riskFreeRateMethod: "zero_curve_interpolated",
        },
      });
      const root = join(dataDir, "market-snapshots");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${record.snapshot.snapshotId}.json`), JSON.stringify(record));

      const dataset = await bindBacktestDataset({
        snapshotId: record.snapshot.snapshotId,
        symbols: ["AAPL"],
        startDate: "2026-01-02",
        endDate: "2026-01-03",
      });

      expect(dataset.qualification).toMatchObject({
        useClass: "strategy_validation",
        universeHistory: "verified",
        corporateActions: "verified",
        pointInTime: "verified",
        universeHistoryRef: { universeId: "sp500", version: "sp500-2026.01" },
        corporateActionLedgerRef: { version: "corp-actions-2026.01" },
        fundamentalLedgerRef: { version: "fundamentals-2026.01" },
      });
      expect(dataset.qualification.limitations).toEqual([]);
      expect(dataset.derivativePricing).toEqual({
        version: "us-options-iv-2026.01",
        source: "fixture_options_vendor",
        asOf: "2026-01-03T00:00:00.000Z",
        impliedVolatilityMethod: "market_quote",
        riskFreeRateMethod: "zero_curve_interpolated",
      });
      expect(dataset.corporateActionEvents).toEqual([
        {
          symbol: "AAPL",
          effectiveDate: "2026-01-02",
          knownAt: "2026-01-01T12:00:00.000Z",
          kind: "cash_dividend",
        },
      ]);
      expect(dataset.fundamentalObservations).toEqual([
        {
          symbol: "AAPL",
          metric: "revenue_ttm",
          fiscalPeriodEnd: "2025-12-31",
          availableAt: "2026-01-01T12:00:00.000Z",
          value: 100,
          revisionId: "filing-r1",
        },
      ]);
    } finally {
      if (priorDataDir === undefined) process.env.QUBIT_DATA_DIR = undefined;
      else process.env.QUBIT_DATA_DIR = priorDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
