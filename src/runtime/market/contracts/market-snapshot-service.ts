/**
 * Market snapshot service (Prime D2).
 * Builds immutable, content-addressable snapshots for research/observe paths.
 * Trading admission stays fail-closed until D3 quality gate.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BarData } from "../../../connectors/data/data.connector";
import { defaultDataDir } from "../../app-paths";
import { computeDateRangeForLimit, queryKlines } from "../klines-query";
import { marketSourceDefinition } from "../market-data-source-control";
import { resolveTickerMarket } from "../resolve-ticker-market";
import {
  type DataQualityVerdict,
  type MarketAssetClass,
  type MarketEventSource,
  type MarketFeedClass,
  type MarketLicenseUse,
  type MarketSnapshot,
  MARKET_EVENT_SCHEMA_VERSION,
  MarketSnapshotSchema,
  evaluateTradability,
  hashPayload,
} from "./market-event-v2";
import {
  assessPriceDivergence,
  assessUpstreamIndependence,
} from "./data-quality-gate";

export type SnapshotPurpose = MarketSnapshot["purpose"];

export type MarketSnapshotGetParams = {
  symbols: string[];
  exchange?: string;
  asOf?: string;
  purpose?: SnapshotPurpose;
  timeframe?: string;
  limit?: number;
  adjustMethod?: string;
  timezone?: string;
  /** Retrieve an existing immutable snapshot without refetching. */
  snapshotId?: string;
};

export type SnapshotBar = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  timestamp: string;
};

export type MarketSnapshotRecord = {
  snapshot: MarketSnapshot;
  dataRef: string;
  barsByInstrument: Record<string, SnapshotBar[]>;
  meta: {
    timeframe: string;
    limit: number;
    barCounts: Record<string, number>;
    sourceIds: string[];
  };
};

export type MarketSnapshotToolResult = {
  ok: true;
  snapshotId: string;
  dataRef: string;
  asOf: string;
  qualityVerdict: DataQualityVerdict;
  snapshot: MarketSnapshot;
  summary: string;
  barCounts: Record<string, number>;
  reused: boolean;
  warnings: string[];
  evidence: Array<{
    ref: string;
    asOf: string;
    quality: string;
    licenseUse: MarketLicenseUse;
  }>;
};

const memoryCatalog = new Map<string, MarketSnapshotRecord>();

export function isMarketSnapshotGetEnabled(): boolean {
  const raw = (process.env.QUBIT_MARKET_SNAPSHOT_GET ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function snapshotsRoot(dataDir?: string): string {
  return join(dataDir ?? defaultDataDir(), "market-snapshots");
}

function instrumentKey(symbol: string, venue: string): string {
  return `${venue}:${symbol}`;
}

function inferAssetClass(symbol: string, venue: string): MarketAssetClass {
  const market = resolveTickerMarket(symbol, { hintExchange: venue }).market;
  if (market === "CRYPTO") return "crypto";
  if (market === "US" || market === "CN" || market === "HK") return "equity";
  return "unknown";
}

function compactBars(bars: BarData[]): SnapshotBar[] {
  return bars.map((bar) => ({
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    turnover: bar.turnover,
    timestamp: bar.timestamp,
  }));
}

function sourceFromDataSourceId(sourceId: string): MarketEventSource {
  const def = marketSourceDefinition(sourceId);
  if (def) {
    return {
      provider: def.id,
      feed: def.feedClass.startsWith("L0") ? "public_aggregate" : "configured_source",
      upstreamFamily: def.upstreamFamily,
      feedClass: def.feedClass,
      licenseUse: def.licenseUse,
    };
  }
  return {
    provider: sourceId || "unknown",
    feed: "stream_or_poll",
    upstreamFamily: sourceId || "unknown",
    feedClass: "L0_research_fallback" satisfies MarketFeedClass,
    licenseUse: "research_only" satisfies MarketLicenseUse,
  };
}

function digestBars(bars: SnapshotBar[]): string {
  return hashPayload(bars);
}

function canonicalFingerprint(input: {
  asOf: string;
  purpose: SnapshotPurpose;
  universe: string[];
  window: { start?: string; end?: string };
  sources: MarketEventSource[];
  sourceRevisions: Record<string, number>;
  adjustMethod: string;
  timezone: string;
  calendarVersion?: string;
  barDigests: Record<string, string>;
  timeframe: string;
  limit: number;
}): string {
  return JSON.stringify({
    asOf: input.asOf,
    purpose: input.purpose,
    universe: [...input.universe].sort(),
    window: input.window,
    sources: input.sources,
    sourceRevisions: input.sourceRevisions,
    adjustMethod: input.adjustMethod,
    timezone: input.timezone,
    calendarVersion: input.calendarVersion ?? null,
    barDigests: Object.fromEntries(
      Object.entries(input.barDigests).sort(([a], [b]) => a.localeCompare(b))
    ),
    timeframe: input.timeframe,
    limit: input.limit,
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
  });
}

export function snapshotIdFromFingerprint(canonical: string): string {
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return `mkt_snapshot_${digest}`;
}

function dataRefFromSnapshotId(snapshotId: string): string {
  return `obs_${snapshotId.replace(/^mkt_snapshot_/, "")}`;
}

function structureValid(bars: SnapshotBar[]): boolean {
  if (bars.length === 0) return false;
  return bars.every(
    (bar) =>
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close) &&
      bar.high >= bar.low &&
      bar.volume >= 0
  );
}

function buildQualityVerdict(input: {
  instrument: { symbol: string; venue: string; assetClass: MarketAssetClass };
  sources: MarketEventSource[];
  asOf: string;
  bars: SnapshotBar[];
  purpose: SnapshotPurpose;
  snapshotId: string;
  peerCloses?: Array<{ upstreamFamily: string; price: number }>;
}): DataQualityVerdict {
  const primary = input.sources[0];
  const feedClass: MarketFeedClass = primary?.feedClass ?? "L0_research_fallback";
  let licenseUse: MarketLicenseUse = primary?.licenseUse ?? "research_only";

  // Only trading-purpose + L3 feed may keep trading_allowed.
  const tradingCandidate =
    input.purpose === "trading" &&
    feedClass === "L3_trading" &&
    licenseUse === "trading_allowed";
  if (!tradingCandidate && licenseUse === "trading_allowed") {
    licenseUse = input.purpose === "observe" ? "observe_only" : "research_only";
  }
  if (input.purpose !== "trading" && licenseUse === "trading_allowed") {
    licenseUse = "research_only";
  }

  const lastTs = input.bars.at(-1)?.timestamp;
  const asOfMs = Date.parse(input.asOf);
  const lastMs = lastTs ? Date.parse(lastTs) : NaN;
  const freshnessMs =
    Number.isFinite(asOfMs) && Number.isFinite(lastMs) ? Math.max(0, asOfMs - lastMs) : null;
  // Intraday trading feeds: 30s; daily research bars: 2d.
  const freshBudgetMs = feedClass === "L3_trading" ? 30_000 : 2 * 86_400_000;
  const freshness =
    freshnessMs == null ? "unknown" : freshnessMs <= freshBudgetMs ? "fresh" : "stale";

  const consistency =
    input.peerCloses && input.peerCloses.length >= 2
      ? assessPriceDivergence(input.peerCloses)
      : assessUpstreamIndependence(input.sources);

  const reasons: string[] = [];
  if (!tradingCandidate) {
    reasons.push(
      feedClass !== "L3_trading"
        ? `feed_class:${feedClass}`
        : input.purpose !== "trading"
          ? `purpose:${input.purpose}`
          : `license:${licenseUse}`
    );
  }

  return evaluateTradability({
    instrument: input.instrument,
    feed: primary?.feed ?? "configured_source",
    kind: "bar",
    asOf: input.asOf,
    freshness,
    completeness: input.bars.length > 0 ? "complete" : "gap_unrecoverable",
    consistency,
    structure: structureValid(input.bars) ? "valid" : "malformed",
    pointInTime: "point_in_time_valid",
    licenseUse: tradingCandidate ? "trading_allowed" : licenseUse,
    snapshotId: input.snapshotId,
    reasons,
  });
}

/** Pure builder — used by service and unit tests. */
export function buildMarketSnapshotRecord(input: {
  asOf: string;
  purpose: SnapshotPurpose;
  instruments: Array<{ symbol: string; venue: string; assetClass: MarketAssetClass }>;
  window: { start?: string; end?: string };
  sources: MarketEventSource[];
  barsByInstrument: Record<string, SnapshotBar[]>;
  timeframe: string;
  limit: number;
  adjustMethod?: string;
  timezone?: string;
  calendarVersion?: string;
  createdAt?: string;
  peerCloses?: Array<{ upstreamFamily: string; price: number }>;
}): MarketSnapshotRecord {
  const universe = input.instruments.map((i) => instrumentKey(i.symbol, i.venue));
  const barDigests = Object.fromEntries(
    Object.entries(input.barsByInstrument).map(([key, bars]) => [key, digestBars(bars)])
  );
  const sourceRevisions = Object.fromEntries(input.sources.map((s) => [s.provider, 0]));
  const adjustMethod = input.adjustMethod ?? "none";
  const timezone = input.timezone ?? "UTC";
  const canonical = canonicalFingerprint({
    asOf: input.asOf,
    purpose: input.purpose,
    universe,
    window: input.window,
    sources: input.sources,
    sourceRevisions,
    adjustMethod,
    timezone,
    calendarVersion: input.calendarVersion,
    barDigests,
    timeframe: input.timeframe,
    limit: input.limit,
  });
  const snapshotId = snapshotIdFromFingerprint(canonical);
  const primary = input.instruments[0]!;
  const primaryBars =
    input.barsByInstrument[instrumentKey(primary.symbol, primary.venue)] ?? [];
  const qualityVerdict = buildQualityVerdict({
    instrument: primary,
    sources: input.sources,
    asOf: input.asOf,
    bars: primaryBars,
    purpose: input.purpose,
    snapshotId,
    peerCloses: input.peerCloses,
  });

  const snapshot = MarketSnapshotSchema.parse({
    snapshotId,
    asOf: input.asOf,
    purpose: input.purpose,
    universe,
    window: input.window,
    sources: input.sources,
    sourceRevisions,
    qualityVerdict,
    adjustMethod,
    timezone,
    calendarVersion: input.calendarVersion,
    eventRefs: [],
    createdAt: input.createdAt ?? new Date().toISOString(),
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
  });

  const barCounts = Object.fromEntries(
    Object.entries(input.barsByInstrument).map(([key, bars]) => [key, bars.length])
  );

  return {
    snapshot,
    dataRef: dataRefFromSnapshotId(snapshotId),
    barsByInstrument: input.barsByInstrument,
    meta: {
      timeframe: input.timeframe,
      limit: input.limit,
      barCounts,
      sourceIds: input.sources.map((s) => s.provider),
    },
  };
}

async function persistRecord(record: MarketSnapshotRecord, dataDir?: string): Promise<void> {
  memoryCatalog.set(record.snapshot.snapshotId, record);
  const root = snapshotsRoot(dataDir);
  await mkdir(root, { recursive: true });
  const path = join(root, `${record.snapshot.snapshotId}.json`);
  await writeFile(path, JSON.stringify(record), "utf8");
}

export async function getMarketSnapshotById(
  snapshotId: string,
  dataDir?: string
): Promise<MarketSnapshotRecord | null> {
  const cached = memoryCatalog.get(snapshotId);
  if (cached) return cached;
  try {
    const path = join(snapshotsRoot(dataDir), `${snapshotId}.json`);
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as MarketSnapshotRecord;
    MarketSnapshotSchema.parse(parsed.snapshot);
    memoryCatalog.set(snapshotId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function clearMarketSnapshotCatalogForTests(): void {
  memoryCatalog.clear();
}

export async function getOrCreateMarketSnapshot(
  params: MarketSnapshotGetParams,
  options?: { dataDir?: string }
): Promise<MarketSnapshotToolResult> {
  if (!isMarketSnapshotGetEnabled()) {
    throw new Error("market.snapshot.get is disabled (QUBIT_MARKET_SNAPSHOT_GET=0)");
  }

  if (params.snapshotId) {
    const existing = await getMarketSnapshotById(params.snapshotId, options?.dataDir);
    if (!existing) throw new Error(`snapshot_not_found:${params.snapshotId}`);
    return toToolResult(existing, true);
  }

  const symbols = [...new Set(params.symbols.map((s) => s.trim()).filter(Boolean))];
  if (symbols.length === 0) throw new Error("missing_symbol: market.snapshot.get requires symbols");

  const purpose: SnapshotPurpose = params.purpose ?? "research";
  const timeframe = (params.timeframe ?? "1d").trim().toLowerCase() || "1d";
  const limit = Math.max(1, Math.min(Number(params.limit ?? 120), 500));
  const asOfMs = params.asOf ? Date.parse(params.asOf) : Date.now();
  if (!Number.isFinite(asOfMs)) throw new Error(`invalid_asOf:${params.asOf}`);
  const asOf = new Date(asOfMs).toISOString();
  const { startDate, endDate } = computeDateRangeForLimit(timeframe, limit, asOfMs);

  const instruments: Array<{ symbol: string; venue: string; assetClass: MarketAssetClass }> = [];
  const barsByInstrument: Record<string, SnapshotBar[]> = {};
  const sourcesByProvider = new Map<string, MarketEventSource>();
  const errors: string[] = [];

  for (const symbol of symbols) {
    const resolved = resolveTickerMarket(symbol, {
      hintExchange: params.exchange,
    });
    const venue = resolved.exchange || params.exchange || resolved.market || "UNKNOWN";
    const instrument = {
      symbol: resolved.symbol || symbol,
      venue,
      assetClass: inferAssetClass(resolved.symbol || symbol, venue),
    };
    instruments.push(instrument);

    const result = await queryKlines({
      symbol: instrument.symbol,
      exchange: venue,
      timeframe,
      limit,
      asOfMs,
    });
    if (result.error || result.bars.length === 0) {
      errors.push(
        `${instrumentKey(instrument.symbol, venue)}:${result.error?.message ?? "empty_bars"}`
      );
      barsByInstrument[instrumentKey(instrument.symbol, venue)] = [];
      continue;
    }
    barsByInstrument[instrumentKey(instrument.symbol, venue)] = compactBars(result.bars);
    const source = sourceFromDataSourceId(result.meta.dataSource);
    sourcesByProvider.set(source.provider, source);
  }

  if (instruments.every((i) => (barsByInstrument[instrumentKey(i.symbol, i.venue)] ?? []).length === 0)) {
    throw new Error(
      `market_snapshot_empty:${errors.join(";") || "no bars returned for universe"}`
    );
  }

  const sources = [...sourcesByProvider.values()];
  if (sources.length === 0) {
    sources.push(sourceFromDataSourceId("unknown"));
  }

  const record = buildMarketSnapshotRecord({
    asOf,
    purpose,
    instruments,
    window: { start: startDate, end: endDate },
    sources,
    barsByInstrument,
    timeframe,
    limit,
    adjustMethod: params.adjustMethod ?? "none",
    timezone: params.timezone ?? "UTC",
  });

  const existing = await getMarketSnapshotById(record.snapshot.snapshotId, options?.dataDir);
  if (existing) return toToolResult(existing, true);

  await persistRecord(record, options?.dataDir);
  return toToolResult(record, false);
}

function toToolResult(record: MarketSnapshotRecord, reused: boolean): MarketSnapshotToolResult {
  const quality =
    record.snapshot.qualityVerdict ??
    evaluateTradability({
      instrument: {
        symbol: record.snapshot.universe[0] ?? "UNKNOWN",
        venue: "UNKNOWN",
        assetClass: "unknown",
      },
      feed: record.snapshot.sources[0]?.feed ?? "unknown",
      kind: "bar",
      asOf: record.snapshot.asOf,
      freshness: "unknown",
      completeness: "complete",
      consistency: "insufficient_peers",
      structure: "valid",
      pointInTime: "point_in_time_valid",
      licenseUse: record.snapshot.sources[0]?.licenseUse ?? "research_only",
      snapshotId: record.snapshot.snapshotId,
    });

  const warnings: string[] = [];
  if (!quality.tradable) {
    warnings.push(
      `not_tradable:${quality.useClass}:${quality.reasons.join(",") || "see_qualityVerdict"}`
    );
  }

  return {
    ok: true,
    snapshotId: record.snapshot.snapshotId,
    dataRef: record.dataRef,
    asOf: record.snapshot.asOf,
    qualityVerdict: quality,
    snapshot: record.snapshot,
    summary: reused
      ? `已复用不可变快照 ${record.snapshot.snapshotId}`
      : `已生成${record.snapshot.purpose}级不可变快照 ${record.snapshot.snapshotId}`,
    barCounts: record.meta.barCounts,
    reused,
    warnings,
    evidence: [
      {
        ref: record.snapshot.snapshotId,
        asOf: record.snapshot.asOf,
        quality: quality.useClass,
        licenseUse: quality.licenseUse,
      },
    ],
  };
}
