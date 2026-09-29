import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MarketSnapshotRecord,
  buildMarketSnapshotRecord,
  canonicalCalendarSessions,
  clearMarketSnapshotCatalogForTests,
  getMarketSnapshotById,
  getOrCreateMarketSnapshot,
  isMarketSnapshotGetEnabled,
  snapshotIdFromFingerprint,
} from "./market-snapshot-service";

afterEach(() => {
  clearMarketSnapshotCatalogForTests();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("missing_test_fixture");
  return value;
}

function integrityFixtureInput(): Parameters<typeof buildMarketSnapshotRecord>[0] {
  return {
    asOf: "2026-08-04T00:00:00.000Z",
    purpose: "research",
    instruments: [{ symbol: "AAPL", venue: "US", assetClass: "equity" }],
    window: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-04T00:00:00.000Z" },
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
          timestamp: "2026-08-03T00:00:00.000Z",
          open: 100,
          high: 101,
          low: 99,
          close: 100.5,
          volume: 10,
          turnover: 1005,
        },
      ],
    },
    timeframe: "1d",
    limit: 10,
    createdAt: "2026-08-04T02:00:00.000Z",
  };
}

async function writeSnapshotFixture(
  dataDir: string,
  record: MarketSnapshotRecord,
  snapshotId = record.snapshot.snapshotId
): Promise<void> {
  const root = join(dataDir, "market-snapshots");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${snapshotId}.json`), JSON.stringify(record));
}

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

  test("calendar provenance is frozen and contributes to the snapshot identity", () => {
    const base = {
      asOf: "2026-08-04T00:00:00.000Z",
      purpose: "backtest" as const,
      instruments: [{ symbol: "AAPL", venue: "US", assetClass: "equity" as const }],
      window: {},
      sources: [
        {
          provider: "fixture",
          feed: "public_aggregate" as const,
          upstreamFamily: "fixture",
          feedClass: "L0_research_fallback" as const,
          licenseUse: "research_only" as const,
        },
      ],
      barsByInstrument: {
        "US:AAPL": [
          {
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
            turnover: 1,
            timestamp: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
      timeframe: "1d",
      limit: 30,
      timezone: "America/New_York",
    };
    const oldCalendar = buildMarketSnapshotRecord({
      ...base,
      calendarVersion: "NYSE-2026.1",
      calendarSessionsByVenue: { US: { "2026-08-01": "open" } },
    });
    const newCalendar = buildMarketSnapshotRecord({
      ...base,
      calendarVersion: "NYSE-2026.2",
      calendarSessionsByVenue: { US: { "2026-08-01": "open" } },
    });
    const closedSession = buildMarketSnapshotRecord({
      ...base,
      calendarVersion: "NYSE-2026.1",
      calendarSessionsByVenue: { US: { "2026-08-01": "closed" } },
    });
    const earlyClose = buildMarketSnapshotRecord({
      ...base,
      calendarVersion: "NYSE-2026.1",
      calendarSessionsByVenue: { US: { "2026-08-01": "open" } },
      calendarSessionWindowsByVenue: {
        US: {
          "2026-08-01": [
            {
              openAt: "2026-08-01T13:30:00.000Z",
              closeAt: "2026-08-01T17:00:00.000Z",
              label: "early_close",
            },
          ],
        },
      },
    });

    expect(oldCalendar.snapshot.calendarVersion).toBe("NYSE-2026.1");
    expect(oldCalendar.snapshot.timezone).toBe("America/New_York");
    expect(oldCalendar.snapshot.snapshotId).not.toBe(newCalendar.snapshot.snapshotId);
    expect(oldCalendar.snapshot.snapshotId).not.toBe(closedSession.snapshot.snapshotId);
    expect(oldCalendar.snapshot.snapshotId).not.toBe(earlyClose.snapshot.snapshotId);
    expect(earlyClose.snapshot.calendarSessionWindowsByVenue?.US?.["2026-08-01"]?.[0]).toEqual(
      expect.objectContaining({ label: "early_close" })
    );
  });

  test("historical universe and corporate-action ledgers are frozen into snapshot identity", () => {
    const base = {
      asOf: "2026-08-04T00:00:00.000Z",
      purpose: "backtest" as const,
      instruments: [{ symbol: "AAPL", venue: "US", assetClass: "equity" as const }],
      window: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-04T00:00:00.000Z" },
      sources: [
        {
          provider: "fixture",
          feed: "licensed_history",
          upstreamFamily: "fixture",
          feedClass: "L1_strategy_validation" as const,
          licenseUse: "research_only" as const,
        },
      ],
      barsByInstrument: {
        "US:AAPL": [
          {
            open: 1,
            high: 1,
            low: 1,
            close: 1,
            volume: 1,
            turnover: 1,
            timestamp: "2026-08-01T00:00:00.000Z",
          },
        ],
      },
      timeframe: "1d",
      limit: 30,
      adjustMethod: "none",
    };
    const first = buildMarketSnapshotRecord({
      ...base,
      universeHistory: {
        universeId: "sp500",
        version: "2026.01",
        source: "fixture_universe",
        asOf: "2026-08-04T00:00:00.000Z",
        membershipIntervals: [{ symbol: "AAPL", startDate: "2020-01-01" }],
      },
      corporateActionLedger: {
        version: "2026.01",
        source: "fixture_actions",
        asOf: "2026-08-04T00:00:00.000Z",
        adjustmentMethod: "none",
        actionsBySymbol: { AAPL: [] },
      },
    });
    const changedHistory = buildMarketSnapshotRecord({
      ...base,
      universeHistory: {
        universeId: "sp500",
        version: "2026.02",
        source: "fixture_universe",
        asOf: "2026-08-04T00:00:00.000Z",
        membershipIntervals: [{ symbol: "AAPL", startDate: "2020-01-01" }],
      },
      corporateActionLedger: {
        version: "2026.01",
        source: "fixture_actions",
        asOf: "2026-08-04T00:00:00.000Z",
        adjustmentMethod: "none",
        actionsBySymbol: { AAPL: [] },
      },
    });
    const changedFundamentals = buildMarketSnapshotRecord({
      ...base,
      universeHistory: first.snapshot.universeHistory,
      corporateActionLedger: first.snapshot.corporateActionLedger,
      fundamentalLedger: {
        version: "fundamentals-2026.02",
        source: "fixture_filings",
        asOf: "2026-08-04T00:00:00.000Z",
        observationsBySymbol: {
          AAPL: [
            {
              metric: "revenue_ttm",
              fiscalPeriodEnd: "2026-06-30",
              availableAt: "2026-07-31T20:00:00.000Z",
              value: 100,
              revisionId: "filing-r2",
            },
          ],
        },
      },
    });
    const changedDerivativePricing = buildMarketSnapshotRecord({
      ...base,
      universeHistory: first.snapshot.universeHistory,
      corporateActionLedger: first.snapshot.corporateActionLedger,
      derivativePricingLedger: {
        version: "us-options-iv-2026.02",
        source: "fixture_options_vendor",
        asOf: "2026-08-04T00:00:00.000Z",
        impliedVolatilityMethod: "surface_interpolated",
        riskFreeRateMethod: "zero_curve_interpolated",
      },
    });

    expect(first.snapshot.snapshotId).not.toBe(changedHistory.snapshot.snapshotId);
    expect(first.snapshot.snapshotId).not.toBe(changedFundamentals.snapshot.snapshotId);
    expect(first.snapshot.snapshotId).not.toBe(changedDerivativePricing.snapshot.snapshotId);
    expect(first.snapshot.universeHistory?.version).toBe("2026.01");
    expect(first.snapshot.corporateActionLedger?.version).toBe("2026.01");
    expect(changedFundamentals.snapshot.fundamentalLedger?.version).toBe("fundamentals-2026.02");
    expect(changedDerivativePricing.snapshot.derivativePricingLedger).toMatchObject({
      version: "us-options-iv-2026.02",
      impliedVolatilityMethod: "surface_interpolated",
    });
  });

  test("canonicalCalendarSessions sorts venues/days for stable fingerprints", () => {
    expect(canonicalCalendarSessions(undefined)).toBeNull();
    expect(
      JSON.stringify(
        canonicalCalendarSessions({
          SZ: { "2026-08-02": "closed", "2026-08-01": "open" },
          SH: { "2026-08-01": "open" },
        })
      )
    ).toBe(
      JSON.stringify({
        SH: { "2026-08-01": "open" },
        SZ: { "2026-08-01": "open", "2026-08-02": "closed" },
      })
    );
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

  test("builder detaches both prices and nested provenance from its caller", () => {
    const input = integrityFixtureInput();
    const record = buildMarketSnapshotRecord(input);
    required(input.barsByInstrument["US:AAPL"]?.[0]).close = 999;
    required(input.sources[0]).provider = "changed_source";
    input.window.end = "2030-01-01T00:00:00.000Z";
    expect(record.barsByInstrument["US:AAPL"]?.[0]?.close).toBe(100.5);
    expect(record.snapshot.sources[0]?.provider).toBe("fixture");
    expect(record.snapshot.window.end).toBe("2026-08-04T00:00:00.000Z");
  });

  test("serialized snapshots remain verifiable after schema property normalization", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-snap-normalize-"));
    try {
      const input = integrityFixtureInput();
      input.sources = [
        {
          licenseUse: "research_only",
          upstreamFamily: "fixture",
          provider: "fixture",
          feed: "public_aggregate",
          feedClass: "L0_research_fallback",
        },
      ];
      input.window = { end: required(input.window.end), start: required(input.window.start) };
      const record = buildMarketSnapshotRecord(input);
      await writeSnapshotFixture(dataDir, record);
      expect(
        (await getMarketSnapshotById(record.snapshot.snapshotId, dataDir))?.snapshot.snapshotId
      ).toBe(record.snapshot.snapshotId);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("tampered prices are rejected even when the original record is already cached", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-snap-tamper-"));
    try {
      const record = buildMarketSnapshotRecord(integrityFixtureInput());
      await writeSnapshotFixture(dataDir, record);
      expect(await getMarketSnapshotById(record.snapshot.snapshotId, dataDir)).not.toBeNull();
      required(record.barsByInstrument["US:AAPL"]?.[0]).close = 100.75;
      await writeSnapshotFixture(dataDir, record);
      await expect(getMarketSnapshotById(record.snapshot.snapshotId, dataDir)).rejects.toThrow(
        "content_hash_mismatch"
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test.each([
    [
      "timeframe",
      (record: MarketSnapshotRecord) => {
        record.meta.timeframe = "1h";
      },
    ],
    [
      "window",
      (record: MarketSnapshotRecord) => {
        record.snapshot.window.end = "2030-01-01";
      },
    ],
    [
      "adjustment",
      (record: MarketSnapshotRecord) => {
        record.snapshot.adjustMethod = "qfq";
      },
    ],
    [
      "sources",
      (record: MarketSnapshotRecord) => {
        required(record.snapshot.sources[0]).provider = "other";
      },
    ],
    [
      "counts",
      (record: MarketSnapshotRecord) => {
        record.meta.barCounts["US:AAPL"] = 100;
      },
    ],
    [
      "source IDs",
      (record: MarketSnapshotRecord) => {
        record.meta.sourceIds = ["other"];
      },
    ],
    [
      "data reference",
      (record: MarketSnapshotRecord) => {
        record.dataRef = "obs_other";
      },
    ],
  ] as const)(
    "tampered %s metadata cannot be used with the original snapshot ID",
    async (_name, tamper) => {
      const dataDir = await mkdtemp(join(tmpdir(), "qb-snap-meta-"));
      try {
        const record = buildMarketSnapshotRecord(integrityFixtureInput());
        tamper(record);
        await writeSnapshotFixture(dataDir, record);
        await expect(getMarketSnapshotById(record.snapshot.snapshotId, dataDir)).rejects.toThrow(
          "market_snapshot_integrity_failed"
        );
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  );

  test("mutating loaded records and tool results does not affect subsequent replay", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-snap-reference-"));
    try {
      const record = buildMarketSnapshotRecord(integrityFixtureInput());
      await writeSnapshotFixture(dataDir, record);
      const first = required(await getMarketSnapshotById(record.snapshot.snapshotId, dataDir));
      required(first.barsByInstrument["US:AAPL"]?.[0]).close = 999;
      required(first.snapshot.sources[0]).provider = "mutated";
      const toolResult = await getOrCreateMarketSnapshot(
        { snapshotId: record.snapshot.snapshotId },
        { dataDir }
      );
      toolResult.snapshot.window.end = "2030-01-01";
      toolResult.barCounts["US:AAPL"] = 999;
      const replay = required(await getMarketSnapshotById(record.snapshot.snapshotId, dataDir));
      expect(replay.barsByInstrument).toEqual(record.barsByInstrument);
      expect(replay.snapshot.sources).toEqual(record.snapshot.sources);
      expect(replay.snapshot.window).toEqual(record.snapshot.window);
      expect(replay.meta.barCounts).toEqual(record.meta.barCounts);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("replay reassesses legacy quality badges instead of trusting unhashed claims", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-snap-quality-"));
    try {
      const record = buildMarketSnapshotRecord(integrityFixtureInput());
      required(record.snapshot.qualityVerdict).pointInTime = "point_in_time_valid";
      required(record.snapshot.qualityVerdict).tradable = true;
      required(record.snapshot.qualityVerdict).useClass = "trading";
      await writeSnapshotFixture(dataDir, record);
      const replay = required(await getMarketSnapshotById(record.snapshot.snapshotId, dataDir));
      expect(replay.snapshot.snapshotId).toBe(record.snapshot.snapshotId);
      expect(replay.snapshot.qualityVerdict?.pointInTime).toBe("unknown");
      expect(replay.snapshot.qualityVerdict?.tradable).toBe(false);
      expect(replay.snapshot.qualityVerdict?.useClass).toBe("research_only");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("a cached snapshot cannot appear in another data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-snap-scope-"));
    try {
      const record = buildMarketSnapshotRecord(integrityFixtureInput());
      await writeSnapshotFixture(join(dataDir, "first"), record);
      expect(
        await getMarketSnapshotById(record.snapshot.snapshotId, join(dataDir, "first"))
      ).not.toBeNull();
      expect(
        await getMarketSnapshotById(record.snapshot.snapshotId, join(dataDir, "second"))
      ).toBeNull();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("snapshot files copied under another ID fail instead of acquiring a new identity", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-snap-identity-"));
    try {
      const record = buildMarketSnapshotRecord(integrityFixtureInput());
      const wrongId = "mkt_snapshot_000000000000000000000000";
      await writeSnapshotFixture(dataDir, record, wrongId);
      await expect(getMarketSnapshotById(wrongId, dataDir)).rejects.toThrow("identity_mismatch");
      await expect(getMarketSnapshotById("../outside", dataDir)).rejects.toThrow(
        "identity_invalid"
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test.each(["2026-08-04T10:00:00", "2026-02-30T00:00:00Z", ""])(
    "snapshot requests reject ambiguous or invalid asOf %s before querying data",
    async (asOf) => {
      await expect(getOrCreateMarketSnapshot({ symbols: ["AAPL"], asOf })).rejects.toThrow(
        "invalid_asOf"
      );
    }
  );

  test("feature flag defaults on", () => {
    const prev = process.env.QUBIT_MARKET_SNAPSHOT_GET;
    process.env.QUBIT_MARKET_SNAPSHOT_GET = undefined;
    expect(isMarketSnapshotGetEnabled()).toBe(true);
    process.env.QUBIT_MARKET_SNAPSHOT_GET = "0";
    expect(isMarketSnapshotGetEnabled()).toBe(false);
    process.env.QUBIT_MARKET_SNAPSHOT_GET = prev;
  });

  test("snapshotIdFromFingerprint is hex digest based", () => {
    expect(snapshotIdFromFingerprint('{"a":1}')).toMatch(/^mkt_snapshot_[a-f0-9]{24}$/);
  });
});
