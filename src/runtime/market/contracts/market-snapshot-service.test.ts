import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMarketSnapshotRecord,
  clearMarketSnapshotCatalogForTests,
  getMarketSnapshotById,
  getOrCreateMarketSnapshot,
  isMarketSnapshotGetEnabled,
  snapshotIdFromFingerprint,
} from "./market-snapshot-service";

afterEach(() => {
  clearMarketSnapshotCatalogForTests();
});

describe("market snapshot service (D2)", () => {
  test("content-addressable snapshotId is stable for identical bar digests", () => {
    const bars = [
      {
        open: 10,
        high: 11,
        low: 9.5,
        close: 10.5,
        volume: 1000,
        turnover: 10500,
        timestamp: "2026-08-01T00:00:00.000Z",
      },
      {
        open: 10.5,
        high: 11.2,
        low: 10.4,
        close: 11,
        volume: 1200,
        turnover: 13200,
        timestamp: "2026-08-04T00:00:00.000Z",
      },
    ];
    const input = {
      asOf: "2026-08-04T00:00:00.000Z",
      purpose: "research" as const,
      instruments: [{ symbol: "600519", venue: "SH", assetClass: "equity" as const }],
      window: { start: "2026-07-01T00:00:00.000Z", end: "2026-08-04T00:00:00.000Z" },
      sources: [
        {
          provider: "eastmoney",
          feed: "public_aggregate",
          upstreamFamily: "eastmoney",
          feedClass: "L0_research_fallback" as const,
          licenseUse: "research_only" as const,
        },
      ],
      barsByInstrument: { "SH:600519": bars },
      timeframe: "1d",
      limit: 120,
      createdAt: "2026-08-04T01:00:00.000Z",
    };

    const a = buildMarketSnapshotRecord(input);
    const b = buildMarketSnapshotRecord(input);
    expect(a.snapshot.snapshotId).toBe(b.snapshot.snapshotId);
    expect(a.snapshot.snapshotId.startsWith("mkt_snapshot_")).toBe(true);
    expect(a.dataRef.startsWith("obs_")).toBe(true);
    expect(a.snapshot.qualityVerdict?.tradable).toBe(false);
    expect(a.snapshot.qualityVerdict?.useClass).not.toBe("trading");
  });

  test("different asOf yields different snapshotId", () => {
    const bars = [
      {
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
        turnover: 1,
        timestamp: "2026-08-01T00:00:00.000Z",
      },
    ];
    const base = {
      purpose: "research" as const,
      instruments: [{ symbol: "AAPL", venue: "US", assetClass: "equity" as const }],
      window: {},
      sources: [
        {
          provider: "yfinance",
          feed: "public_aggregate",
          upstreamFamily: "yfinance",
          feedClass: "L0_research_fallback" as const,
          licenseUse: "research_only" as const,
        },
      ],
      barsByInstrument: { "US:AAPL": bars },
      timeframe: "1d",
      limit: 30,
      createdAt: "2026-08-04T01:00:00.000Z",
    };
    const a = buildMarketSnapshotRecord({ ...base, asOf: "2026-08-01T00:00:00.000Z" });
    const b = buildMarketSnapshotRecord({ ...base, asOf: "2026-08-02T00:00:00.000Z" });
    expect(a.snapshot.snapshotId).not.toBe(b.snapshot.snapshotId);
  });

  test("persists and reuses snapshot by id", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-snap-"));
    try {
      const bars = [
        {
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 10,
          turnover: 1005,
          timestamp: "2026-08-03T00:00:00.000Z",
        },
      ];
      const record = buildMarketSnapshotRecord({
        asOf: "2026-08-04T00:00:00.000Z",
        purpose: "observe",
        instruments: [{ symbol: "BTCUSDT", venue: "CRYPTO", assetClass: "crypto" }],
        window: { end: "2026-08-04T00:00:00.000Z" },
        sources: [
          {
            provider: "binance_crypto",
            feed: "venue_websocket",
            upstreamFamily: "binance",
            feedClass: "L2_realtime_observe",
            licenseUse: "observe_only",
          },
        ],
        barsByInstrument: { "CRYPTO:BTCUSDT": bars },
        timeframe: "1d",
        limit: 10,
        createdAt: "2026-08-04T02:00:00.000Z",
      });

      // Seed catalog via get path after manual write through getOrCreate of synthetic:
      // persist by calling getMarketSnapshotById miss then writing via private path —
      // use getOrCreate with snapshotId after injecting into disk by rebuilding:
      const { writeFile, mkdir } = await import("node:fs/promises");
      const root = join(dataDir, "market-snapshots");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${record.snapshot.snapshotId}.json`), JSON.stringify(record));

      clearMarketSnapshotCatalogForTests();
      const loaded = await getMarketSnapshotById(record.snapshot.snapshotId, dataDir);
      expect(loaded?.snapshot.snapshotId).toBe(record.snapshot.snapshotId);

      const reused = await getOrCreateMarketSnapshot(
        { snapshotId: record.snapshot.snapshotId },
        { dataDir }
      );
      expect(reused.reused).toBe(true);
      expect(reused.snapshotId).toBe(record.snapshot.snapshotId);
      expect(reused.ok).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("feature flag defaults on", () => {
    const prev = process.env.QUBIT_MARKET_SNAPSHOT_GET;
    delete process.env.QUBIT_MARKET_SNAPSHOT_GET;
    expect(isMarketSnapshotGetEnabled()).toBe(true);
    process.env.QUBIT_MARKET_SNAPSHOT_GET = "0";
    expect(isMarketSnapshotGetEnabled()).toBe(false);
    if (prev === undefined) delete process.env.QUBIT_MARKET_SNAPSHOT_GET;
    else process.env.QUBIT_MARKET_SNAPSHOT_GET = prev;
  });

  test("snapshotIdFromFingerprint is hex digest based", () => {
    expect(snapshotIdFromFingerprint('{"a":1}')).toMatch(/^mkt_snapshot_[a-f0-9]{24}$/);
  });
});
