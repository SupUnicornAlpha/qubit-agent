import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessPriceDivergence,
  assessUpstreamIndependence,
  isMarketQualityGateEnabled,
} from "./data-quality-gate";
import { evaluateOrderDataQualityGate } from "./order-data-quality-gate";
import {
  buildMarketSnapshotRecord,
  clearMarketSnapshotCatalogForTests,
} from "./market-snapshot-service";

const prevGate = process.env.QUBIT_MARKET_QUALITY_GATE;

afterEach(() => {
  clearMarketSnapshotCatalogForTests();
  if (prevGate === undefined) delete process.env.QUBIT_MARKET_QUALITY_GATE;
  else process.env.QUBIT_MARKET_QUALITY_GATE = prevGate;
});

describe("data quality assessments (D3)", () => {
  test("same upstreamFamily is never verified", () => {
    expect(
      assessUpstreamIndependence([
        { upstreamFamily: "eastmoney" },
        { upstreamFamily: "eastmoney" },
      ])
    ).toBe("insufficient_peers");
  });

  test("independent families can verify; large price gap is divergent", () => {
    expect(
      assessUpstreamIndependence([
        { upstreamFamily: "wind" },
        { upstreamFamily: "broker" },
      ])
    ).toBe("verified");

    expect(
      assessPriceDivergence(
        [
          { upstreamFamily: "wind", price: 100 },
          { upstreamFamily: "broker", price: 100.2 },
        ],
        0.005
      )
    ).toBe("verified");

    expect(
      assessPriceDivergence(
        [
          { upstreamFamily: "wind", price: 100 },
          { upstreamFamily: "broker", price: 102 },
        ],
        0.005
      )
    ).toBe("divergent");

    expect(
      assessPriceDivergence([
        { upstreamFamily: "eastmoney", price: 100 },
        { upstreamFamily: "akshare", price: 100 }, // same family via mapping? no — different strings
      ])
    ).toBe("verified");

    expect(
      assessPriceDivergence([
        { upstreamFamily: "eastmoney", price: 100 },
        { upstreamFamily: "eastmoney", price: 100.1 },
      ])
    ).toBe("insufficient_peers");
  });
});

describe("order data quality gate (D3)", () => {
  test("paper without snapshot is allowed with warning when gate on", async () => {
    process.env.QUBIT_MARKET_QUALITY_GATE = "1";
    const result = await evaluateOrderDataQualityGate({ dispatchMode: "paper" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContain("data_quality:snapshot_omitted_paper_compat");
    }
  });

  test("live without snapshot is fail-closed", async () => {
    process.env.QUBIT_MARKET_QUALITY_GATE = "1";
    const result = await evaluateOrderDataQualityGate({ dispatchMode: "live" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("snapshot_required");
  });

  test("non-tradable snapshot blocks even on paper when provided", async () => {
    process.env.QUBIT_MARKET_QUALITY_GATE = "1";
    const dataDir = await mkdtempSafe();
    try {
      const record = buildMarketSnapshotRecord({
        asOf: "2026-08-04T00:00:00.000Z",
        purpose: "research",
        instruments: [{ symbol: "600519", venue: "SH", assetClass: "equity" }],
        window: {},
        sources: [
          {
            provider: "eastmoney",
            feed: "public_aggregate",
            upstreamFamily: "eastmoney",
            feedClass: "L0_research_fallback",
            licenseUse: "research_only",
          },
        ],
        barsByInstrument: {
          "SH:600519": [
            {
              open: 10,
              high: 11,
              low: 9,
              close: 10.5,
              volume: 1,
              turnover: 10,
              timestamp: "2026-08-03T00:00:00.000Z",
            },
          ],
        },
        timeframe: "1d",
        limit: 10,
        createdAt: "2026-08-04T01:00:00.000Z",
      });
      expect(record.snapshot.qualityVerdict?.tradable).toBe(false);

      const root = join(dataDir, "market-snapshots");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${record.snapshot.snapshotId}.json`), JSON.stringify(record));
      clearMarketSnapshotCatalogForTests();

      const result = await evaluateOrderDataQualityGate(
        { dispatchMode: "paper", snapshotId: record.snapshot.snapshotId },
        { dataDir }
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("not_tradable");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("L3 trading snapshot can be tradable and pass the gate", async () => {
    process.env.QUBIT_MARKET_QUALITY_GATE = "1";
    const dataDir = await mkdtempSafe();
    try {
      const asOf = "2026-08-04T01:30:00.000Z";
      const record = buildMarketSnapshotRecord({
        asOf,
        purpose: "trading",
        instruments: [{ symbol: "ES", venue: "CME", assetClass: "future" }],
        window: {},
        sources: [
          {
            provider: "cme_gateway",
            feed: "exchange_licensed",
            upstreamFamily: "cme",
            feedClass: "L3_trading",
            licenseUse: "trading_allowed",
          },
          {
            provider: "broker_feed",
            feed: "broker_gateway",
            upstreamFamily: "broker",
            feedClass: "L3_trading",
            licenseUse: "trading_allowed",
          },
        ],
        barsByInstrument: {
          "CME:ES": [
            {
              open: 5000,
              high: 5001,
              low: 4999,
              close: 5000.5,
              volume: 10,
              turnover: 50005,
              timestamp: "2026-08-04T01:29:50.000Z",
            },
          ],
        },
        timeframe: "1m",
        limit: 5,
        createdAt: asOf,
        peerCloses: [
          { upstreamFamily: "cme", price: 5000.5 },
          { upstreamFamily: "broker", price: 5000.6 },
        ],
      });
      expect(record.snapshot.qualityVerdict?.tradable).toBe(true);
      expect(record.snapshot.qualityVerdict?.consistency).toBe("verified");

      const root = join(dataDir, "market-snapshots");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${record.snapshot.snapshotId}.json`), JSON.stringify(record));
      clearMarketSnapshotCatalogForTests();

      const result = await evaluateOrderDataQualityGate(
        { dispatchMode: "live", snapshotId: record.snapshot.snapshotId },
        { dataDir }
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.verdict?.tradable).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("feature flag defaults on", () => {
    delete process.env.QUBIT_MARKET_QUALITY_GATE;
    expect(isMarketQualityGateEnabled()).toBe(true);
  });
});

async function mkdtempSafe(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), "qb-dq-"));
}
