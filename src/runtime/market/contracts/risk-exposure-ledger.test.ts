import { describe, expect, test } from "bun:test";
import { buildMarketSnapshotRecord } from "./market-snapshot-service";

const makeRecord = (version: string) =>
  buildMarketSnapshotRecord({
    asOf: "2026-08-29T00:00:00.000Z",
    purpose: "backtest",
    instruments: [{ symbol: "AAPL", venue: "US", assetClass: "equity" }],
    window: { start: "2026-08-01", end: "2026-08-28" },
    sources: [{ provider: "fixture", feed: "fixture", upstreamFamily: "fixture" }],
    barsByInstrument: {
      "US:AAPL": [
        {
          timestamp: "2026-08-28T00:00:00.000Z",
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
    limit: 1,
    riskExposureLedger: {
      version,
      source: "risk-model-fixture",
      asOf: "2026-08-29T00:00:00.000Z",
      model: "style-v1",
      observationsBySymbol: {
        AAPL: [
          {
            effectiveDate: "2026-08-28",
            availableAt: "2026-08-28T21:00:00.000Z",
            exposures: { market_beta: 1.1, growth: 0.4, technology: 1 },
            revisionId: "r1",
          },
        ],
      },
    },
  });

describe("risk exposure ledger snapshot provenance", () => {
  test("persists and fingerprints the versioned PIT risk model", () => {
    const first = makeRecord("2026.08.1");
    const revised = makeRecord("2026.08.2");
    expect(first.snapshot.riskExposureLedger?.observationsBySymbol.AAPL?.[0]?.availableAt).toBe(
      "2026-08-28T21:00:00.000Z"
    );
    expect(first.snapshot.snapshotId).not.toBe(revised.snapshot.snapshotId);
  });
});
