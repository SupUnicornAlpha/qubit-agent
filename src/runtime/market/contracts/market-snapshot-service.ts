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
import { assessPriceDivergence, assessUpstreamIndependence } from "./data-quality-gate";
import {
  type DataQualityVerdict,
  MARKET_EVENT_SCHEMA_VERSION,
  type MarketAssetClass,
  type MarketCalendarSessionWindowsByVenue,
  type MarketCalendarSessionsByVenue,
  type MarketCorporateActionLedger,
  type MarketDerivativePricingLedger,
  type MarketEventSource,
  type MarketFeedClass,
  type MarketFundamentalLedger,
  type MarketLicenseUse,
  type MarketRiskExposureLedger,
  type MarketSnapshot,
  MarketSnapshotSchema,
  type MarketUniverseHistory,
  evaluateTradability,
  hashPayload,
} from "./market-event-v2";
import { pointInTimeMillis } from "./point-in-time-clock";

export type SnapshotPurpose = MarketSnapshot["purpose"];

export type MarketSnapshotGetParams = {
  /** Optional only when replaying an existing immutable snapshotId. */
  symbols?: string[];
  exchange?: string;
  asOf?: string;
  purpose?: SnapshotPurpose;
  timeframe?: string;
  limit?: number;
  adjustMethod?: string;
  timezone?: string;
  /** Versioned exchange calendar release used to interpret session dates. */
  calendarVersion?: string;
  /** Explicit daily session states, keyed by venue then YYYY-MM-DD. */
  calendarSessionsByVenue?: MarketCalendarSessionsByVenue;
  /** Explicit intraday windows keyed by venue then session date. */
  calendarSessionWindowsByVenue?: MarketCalendarSessionWindowsByVenue;
  /** Versioned membership intervals for the historical universe. */
  universeHistory?: MarketUniverseHistory;
  /** Versioned point-in-time corporate-action ledger. */
  corporateActionLedger?: MarketCorporateActionLedger;
  /** Versioned point-in-time financial-statement / estimate revisions. */
  fundamentalLedger?: MarketFundamentalLedger;
  riskExposureLedger?: MarketRiskExposureLedger;
  /** Versioned IV/rate-curve provenance used for derivative risk audit. */
  derivativePricingLedger?: MarketDerivativePricingLedger;
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
  /** 数据源提供时保留官方结算价，供期权/期货到期生命周期使用。 */
  settlementPrice?: number;
  /** 永续合约该周期资金费率（bps）。 */
  fundingRateBps?: number;
  impliedVolatility?: number;
  riskFreeRateAnnual?: number;
  tradable?: boolean;
  suspended?: boolean;
  priceLimitUp?: number;
  priceLimitDown?: number;
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
  /** Alias for backtest.run / factor.promote_backtest contract compatibility. */
  dataset_snapshot_id: string;
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

// Key by storage path, not just content ID: separate workspaces must never
// borrow one another's snapshots. Cached records are private immutable copies.
const memoryCatalog = new Map<string, { raw: string; record: MarketSnapshotRecord }>();

export class MarketSnapshotIntegrityError extends Error {
  readonly code = "market_snapshot_integrity_failed";

  constructor(snapshotId: string, reason: string) {
    super(`market_snapshot_integrity_failed:${snapshotId}:${reason}`);
    this.name = "MarketSnapshotIntegrityError";
  }
}

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
  if (market === "FUTURES") return "future";
  if (market === "OPTION") return "option";
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

/** Stable JSON shape for calendar sessions so fingerprint order does not churn. */
export function canonicalCalendarSessions(
  sessions?: unknown
): MarketCalendarSessionsByVenue | null {
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return null;
  const out: MarketCalendarSessionsByVenue = {};
  for (const venue of Object.keys(sessions).sort()) {
    const days = (sessions as Record<string, unknown>)[venue];
    if (!days || typeof days !== "object") continue;
    const sortedDays: Record<string, "open" | "closed"> = {};
    for (const day of Object.keys(days).sort()) {
      const state = (days as Record<string, unknown>)[day];
      if (state === "open" || state === "closed") sortedDays[day] = state;
    }
    if (Object.keys(sortedDays).length > 0) out[venue] = sortedDays;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Stable, validated shape for open/close windows; missing windows are never inferred. */
export function canonicalCalendarSessionWindows(
  windows?: unknown
): MarketCalendarSessionWindowsByVenue | null {
  if (!windows || typeof windows !== "object" || Array.isArray(windows)) return null;
  const out: MarketCalendarSessionWindowsByVenue = {};
  for (const venue of Object.keys(windows).sort()) {
    const days = (windows as Record<string, unknown>)[venue];
    if (!days || typeof days !== "object" || Array.isArray(days)) continue;
    const normalizedDays: Record<
      string,
      Array<{ openAt: string; closeAt: string; label?: string }>
    > = {};
    for (const date of Object.keys(days).sort()) {
      const rawWindows = (days as Record<string, unknown>)[date];
      if (!Array.isArray(rawWindows)) continue;
      const normalized = rawWindows
        .filter((window): window is { openAt: string; closeAt: string; label?: string } => {
          if (!window || typeof window !== "object") return false;
          const raw = window as Record<string, unknown>;
          return (
            typeof raw.openAt === "string" &&
            typeof raw.closeAt === "string" &&
            Number.isFinite(Date.parse(raw.openAt)) &&
            Number.isFinite(Date.parse(raw.closeAt)) &&
            Date.parse(raw.openAt) < Date.parse(raw.closeAt)
          );
        })
        .map((window) => ({
          openAt: window.openAt,
          closeAt: window.closeAt,
          ...(typeof window.label === "string" && window.label.trim()
            ? { label: window.label.trim() }
            : {}),
        }))
        .sort(
          (left, right) =>
            left.openAt.localeCompare(right.openAt) || left.closeAt.localeCompare(right.closeAt)
        );
      if (normalized.length > 0) normalizedDays[date] = normalized;
    }
    if (Object.keys(normalizedDays).length > 0) out[venue] = normalizedDays;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Stable, sorted shape for historical membership evidence in the snapshot fingerprint. */
export function canonicalUniverseHistory(
  history?: MarketUniverseHistory
): MarketUniverseHistory | undefined {
  if (!history) return undefined;
  return {
    universeId: history.universeId.trim(),
    version: history.version.trim(),
    source: history.source.trim(),
    asOf: history.asOf,
    membershipIntervals: [...history.membershipIntervals]
      .map((interval) => ({
        symbol: interval.symbol.trim().toUpperCase(),
        startDate: interval.startDate,
        ...(interval.endDate ? { endDate: interval.endDate } : {}),
      }))
      .sort(
        (left, right) =>
          left.symbol.localeCompare(right.symbol) ||
          left.startDate.localeCompare(right.startDate) ||
          (left.endDate ?? "").localeCompare(right.endDate ?? "")
      ),
  };
}

/** Stable, sorted shape for corporate-action evidence in the snapshot fingerprint. */
export function canonicalCorporateActionLedger(
  ledger?: MarketCorporateActionLedger
): MarketCorporateActionLedger | undefined {
  if (!ledger) return undefined;
  return {
    version: ledger.version.trim(),
    source: ledger.source.trim(),
    asOf: ledger.asOf,
    adjustmentMethod: ledger.adjustmentMethod.trim(),
    actionsBySymbol: Object.fromEntries(
      Object.entries(ledger.actionsBySymbol)
        .map(([symbol, actions]) => [
          symbol.trim().toUpperCase(),
          [...actions].sort(
            (left, right) =>
              left.effectiveDate.localeCompare(right.effectiveDate) ||
              left.knownAt.localeCompare(right.knownAt) ||
              left.kind.localeCompare(right.kind)
          ),
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    ),
  };
}

/** Stable, sorted shape for point-in-time fundamental revisions in the snapshot fingerprint. */
export function canonicalFundamentalLedger(
  ledger?: MarketFundamentalLedger
): MarketFundamentalLedger | undefined {
  if (!ledger) return undefined;
  return {
    version: ledger.version.trim(),
    source: ledger.source.trim(),
    asOf: ledger.asOf,
    observationsBySymbol: Object.fromEntries(
      (
        Object.entries(ledger.observationsBySymbol) as Array<
          [string, MarketFundamentalLedger["observationsBySymbol"][string]]
        >
      )
        .map(([symbol, observations]) => [
          symbol.trim().toUpperCase(),
          [...observations].sort(
            (left, right) =>
              left.availableAt.localeCompare(right.availableAt) ||
              left.fiscalPeriodEnd.localeCompare(right.fiscalPeriodEnd) ||
              left.metric.localeCompare(right.metric) ||
              (left.revisionId ?? "").localeCompare(right.revisionId ?? "")
          ),
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    ),
  };
}

/** Stable shape for external industry/style/market exposure revisions. */
export function canonicalRiskExposureLedger(
  ledger?: MarketRiskExposureLedger
): MarketRiskExposureLedger | undefined {
  if (!ledger) return undefined;
  return {
    version: ledger.version.trim(),
    source: ledger.source.trim(),
    asOf: ledger.asOf,
    model: ledger.model.trim(),
    observationsBySymbol: Object.fromEntries(
      (
        Object.entries(ledger.observationsBySymbol) as Array<
          [string, MarketRiskExposureLedger["observationsBySymbol"][string]]
        >
      )
        .map(([symbol, observations]) => [
          symbol.trim().toUpperCase(),
          [...observations].sort(
            (left, right) =>
              left.availableAt.localeCompare(right.availableAt) ||
              left.effectiveDate.localeCompare(right.effectiveDate) ||
              (left.revisionId ?? "").localeCompare(right.revisionId ?? "")
          ),
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    ),
  };
}

/** Stable shape for the curve/quote release that supplied derivative risk inputs. */
export function canonicalDerivativePricingLedger(
  ledger?: MarketDerivativePricingLedger
): MarketDerivativePricingLedger | undefined {
  if (!ledger) return undefined;
  return {
    version: ledger.version.trim(),
    source: ledger.source.trim(),
    asOf: ledger.asOf,
    impliedVolatilityMethod: ledger.impliedVolatilityMethod,
    riskFreeRateMethod: ledger.riskFreeRateMethod,
  };
}

function canonicalFingerprint(input: {
  asOf: string;
  purpose: SnapshotPurpose;
  universe: string[];
  window: MarketSnapshot["window"];
  sources: MarketEventSource[];
  sourceRevisions: Record<string, number>;
  adjustMethod: string;
  timezone: string;
  calendarVersion?: string | undefined;
  calendarSessionsByVenue?: MarketCalendarSessionsByVenue | undefined;
  calendarSessionWindowsByVenue?: MarketCalendarSessionWindowsByVenue | undefined;
  universeHistory?: MarketUniverseHistory | undefined;
  corporateActionLedger?: MarketCorporateActionLedger | undefined;
  fundamentalLedger?: MarketFundamentalLedger | undefined;
  riskExposureLedger?: MarketRiskExposureLedger | undefined;
  derivativePricingLedger?: MarketDerivativePricingLedger | undefined;
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
    calendarSessionsByVenue: canonicalCalendarSessions(input.calendarSessionsByVenue),
    calendarSessionWindowsByVenue: canonicalCalendarSessionWindows(
      input.calendarSessionWindowsByVenue
    ),
    universeHistory: canonicalUniverseHistory(input.universeHistory) ?? null,
    corporateActionLedger: canonicalCorporateActionLedger(input.corporateActionLedger) ?? null,
    fundamentalLedger: canonicalFundamentalLedger(input.fundamentalLedger) ?? null,
    riskExposureLedger: canonicalRiskExposureLedger(input.riskExposureLedger) ?? null,
    derivativePricingLedger:
      canonicalDerivativePricingLedger(input.derivativePricingLedger) ?? null,
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

function fingerprintForRecord(record: MarketSnapshotRecord): string {
  const { snapshot, meta } = record;
  return canonicalFingerprint({
    asOf: snapshot.asOf,
    purpose: snapshot.purpose,
    universe: snapshot.universe,
    window: snapshot.window,
    sources: snapshot.sources,
    sourceRevisions: snapshot.sourceRevisions,
    adjustMethod: snapshot.adjustMethod ?? "none",
    timezone: snapshot.timezone,
    calendarVersion: snapshot.calendarVersion,
    calendarSessionsByVenue: snapshot.calendarSessionsByVenue,
    calendarSessionWindowsByVenue: snapshot.calendarSessionWindowsByVenue,
    universeHistory: snapshot.universeHistory,
    corporateActionLedger: snapshot.corporateActionLedger,
    fundamentalLedger: snapshot.fundamentalLedger,
    riskExposureLedger: snapshot.riskExposureLedger,
    derivativePricingLedger: snapshot.derivativePricingLedger,
    barDigests: Object.fromEntries(
      Object.entries(record.barsByInstrument).map(([key, bars]) => [key, digestBars(bars)])
    ),
    timeframe: meta.timeframe,
    limit: meta.limit,
  });
}

function assertSnapshotIntegrity(record: MarketSnapshotRecord, snapshotId: string): void {
  const fail = (reason: string): never => {
    throw new MarketSnapshotIntegrityError(snapshotId, reason);
  };
  MarketSnapshotSchema.parse(record.snapshot);
  if (record.snapshot.snapshotId !== snapshotId) fail("identity_mismatch");
  if (!record.meta || typeof record.meta.timeframe !== "string" || !record.meta.timeframe) {
    fail("metadata_invalid");
  }
  if (!Number.isInteger(record.meta.limit) || record.meta.limit <= 0) fail("metadata_invalid");
  if (
    !record.barsByInstrument ||
    typeof record.barsByInstrument !== "object" ||
    Array.isArray(record.barsByInstrument)
  ) {
    fail("bars_invalid");
  }
  const instruments = Object.keys(record.barsByInstrument).sort();
  if (JSON.stringify(instruments) !== JSON.stringify([...record.snapshot.universe].sort())) {
    fail("universe_mismatch");
  }
  for (const bars of Object.values(record.barsByInstrument)) {
    if (!Array.isArray(bars)) fail("bars_invalid");
    for (const bar of bars) {
      if (
        !bar ||
        typeof bar.timestamp !== "string" ||
        !Number.isFinite(Date.parse(bar.timestamp)) ||
        ![bar.open, bar.high, bar.low, bar.close, bar.volume, bar.turnover].every(Number.isFinite)
      ) {
        fail("bars_invalid");
      }
    }
  }
  if (snapshotIdFromFingerprint(fingerprintForRecord(record)) !== snapshotId) {
    fail("content_hash_mismatch");
  }
  if (record.dataRef !== dataRefFromSnapshotId(snapshotId)) fail("data_ref_mismatch");
  const counts = record.meta.barCounts;
  if (
    !counts ||
    JSON.stringify(Object.keys(counts).sort()) !== JSON.stringify(instruments) ||
    instruments.some((key) => counts[key] !== record.barsByInstrument[key]?.length)
  ) {
    fail("bar_counts_mismatch");
  }
  if (
    JSON.stringify(record.meta.sourceIds) !==
    JSON.stringify(record.snapshot.sources.map((source) => source.provider))
  ) {
    fail("source_ids_mismatch");
  }
}

/** Quality was never part of the legacy content hash; do not trust a saved badge. */
function reassessStoredQuality(record: MarketSnapshotRecord): void {
  const key = record.snapshot.universe[0];
  if (!key) throw new MarketSnapshotIntegrityError(record.snapshot.snapshotId, "universe_empty");
  const separator = key.indexOf(":");
  const venue = key.slice(0, separator);
  const symbol = key.slice(separator + 1);
  record.snapshot.qualityVerdict = buildQualityVerdict({
    instrument: { symbol, venue, assetClass: inferAssetClass(symbol, venue) },
    sources: record.snapshot.sources,
    asOf: record.snapshot.asOf,
    bars: record.barsByInstrument[key] ?? [],
    purpose: record.snapshot.purpose,
    snapshotId: record.snapshot.snapshotId,
  });
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
    input.purpose === "trading" && feedClass === "L3_trading" && licenseUse === "trading_allowed";
  if (!tradingCandidate && licenseUse === "trading_allowed") {
    licenseUse = input.purpose === "observe" ? "observe_only" : "research_only";
  }
  if (input.purpose !== "trading" && licenseUse === "trading_allowed") {
    licenseUse = "research_only";
  }

  const lastTs = input.bars.at(-1)?.timestamp;
  const asOfMs = pointInTimeMillis(input.asOf);
  const lastMs = lastTs ? pointInTimeMillis(lastTs) : Number.NaN;
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
  // A bar's event time does not establish when this revision was available.
  // Current historical queries therefore remain usable for research, while
  // trusted as-of source adapters are required before PIT can be verified.
  const invalidBoundary =
    !Number.isFinite(asOfMs) ||
    input.bars.some((bar) => {
      const timestamp = pointInTimeMillis(bar.timestamp);
      return !Number.isFinite(timestamp) || timestamp > asOfMs;
    });
  reasons.push(
    invalidBoundary ? "point_in_time_boundary_invalid" : "point_in_time_provenance_not_verified"
  );
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
    pointInTime: invalidBoundary ? "invalid" : "unknown",
    licenseUse: tradingCandidate ? "trading_allowed" : licenseUse,
    snapshotId: input.snapshotId,
    reasons,
  });
}

/** Pure builder — used by service and unit tests. */
export function buildMarketSnapshotRecord(sourceInput: {
  asOf: string;
  purpose: SnapshotPurpose;
  instruments: Array<{ symbol: string; venue: string; assetClass: MarketAssetClass }>;
  window: { start?: string | undefined; end?: string };
  sources: MarketEventSource[];
  barsByInstrument: Record<string, SnapshotBar[]>;
  timeframe: string;
  limit: number;
  adjustMethod?: string | undefined;
  timezone?: string | undefined;
  calendarVersion?: string | undefined;
  calendarSessionsByVenue?: MarketCalendarSessionsByVenue | undefined;
  calendarSessionWindowsByVenue?: MarketCalendarSessionWindowsByVenue | undefined;
  universeHistory?: MarketUniverseHistory | undefined;
  corporateActionLedger?: MarketCorporateActionLedger | undefined;
  fundamentalLedger?: MarketFundamentalLedger | undefined;
  riskExposureLedger?: MarketRiskExposureLedger | undefined;
  derivativePricingLedger?: MarketDerivativePricingLedger | undefined;
  createdAt?: string | undefined;
  peerCloses?: Array<{ upstreamFamily: string; price: number }>;
}): MarketSnapshotRecord {
  // Neither the returned bars nor nested provenance may retain caller-owned references.
  const input = structuredClone(sourceInput);
  const primary = input.instruments[0];
  if (!primary) throw new MarketSnapshotIntegrityError("unassigned", "universe_empty");
  const snapshot = MarketSnapshotSchema.parse({
    snapshotId: "pending",
    asOf: input.asOf,
    purpose: input.purpose,
    universe: input.instruments.map((instrument) =>
      instrumentKey(instrument.symbol, instrument.venue)
    ),
    window: input.window,
    sources: input.sources,
    sourceRevisions: Object.fromEntries(input.sources.map((source) => [source.provider, 0])),
    adjustMethod: input.adjustMethod ?? "none",
    universeHistory: canonicalUniverseHistory(input.universeHistory),
    corporateActionLedger: canonicalCorporateActionLedger(input.corporateActionLedger),
    fundamentalLedger: canonicalFundamentalLedger(input.fundamentalLedger),
    riskExposureLedger: canonicalRiskExposureLedger(input.riskExposureLedger),
    derivativePricingLedger: canonicalDerivativePricingLedger(input.derivativePricingLedger),
    timezone: input.timezone ?? "UTC",
    calendarVersion: input.calendarVersion,
    calendarSessionsByVenue: canonicalCalendarSessions(input.calendarSessionsByVenue) ?? undefined,
    calendarSessionWindowsByVenue:
      canonicalCalendarSessionWindows(input.calendarSessionWindowsByVenue) ?? undefined,
    eventRefs: [],
    createdAt: input.createdAt ?? new Date().toISOString(),
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
  });
  const record: MarketSnapshotRecord = {
    snapshot,
    dataRef: "pending",
    barsByInstrument: input.barsByInstrument,
    meta: {
      timeframe: input.timeframe,
      limit: input.limit,
      barCounts: Object.fromEntries(
        Object.entries(input.barsByInstrument).map(([key, bars]) => [key, bars.length])
      ),
      sourceIds: snapshot.sources.map((source) => source.provider),
    },
  };
  // Hash the schema-normalized representation so the content identity survives
  // serialization even when a caller supplied object properties in another order.
  const snapshotId = snapshotIdFromFingerprint(fingerprintForRecord(record));
  snapshot.snapshotId = snapshotId;
  record.dataRef = dataRefFromSnapshotId(snapshotId);
  snapshot.qualityVerdict = buildQualityVerdict({
    instrument: primary,
    sources: snapshot.sources,
    asOf: snapshot.asOf,
    bars: record.barsByInstrument[instrumentKey(primary.symbol, primary.venue)] ?? [],
    purpose: snapshot.purpose,
    snapshotId,
    ...(input.peerCloses ? { peerCloses: input.peerCloses } : {}),
  });
  return record;
}

async function persistRecord(
  input: MarketSnapshotRecord,
  dataDir?: string
): Promise<MarketSnapshotRecord> {
  const record = structuredClone(input);
  assertSnapshotIntegrity(record, record.snapshot.snapshotId);
  const root = snapshotsRoot(dataDir);
  await mkdir(root, { recursive: true });
  const path = join(root, `${record.snapshot.snapshotId}.json`);
  const raw = JSON.stringify(record);
  try {
    await writeFile(path, raw, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await getMarketSnapshotById(record.snapshot.snapshotId, dataDir);
    if (!existing) throw new MarketSnapshotIntegrityError(record.snapshot.snapshotId, "write_race");
    return existing;
  }
  memoryCatalog.set(path, { raw, record });
  return structuredClone(record);
}

export async function getMarketSnapshotById(
  snapshotId: string,
  dataDir?: string
): Promise<MarketSnapshotRecord | null> {
  if (!/^mkt_snapshot_[a-f0-9]{24}$/.test(snapshotId)) {
    throw new MarketSnapshotIntegrityError(snapshotId, "identity_invalid");
  }
  const path = join(snapshotsRoot(dataDir), `${snapshotId}.json`);
  let raw: string;
  try {
    // Read on every access: a cached ID must not hide a changed or deleted file.
    raw = await readFile(path, "utf8");
  } catch (error) {
    memoryCatalog.delete(path);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const cached = memoryCatalog.get(path);
  if (cached?.raw === raw) return structuredClone(cached.record);
  try {
    const parsed = JSON.parse(raw) as MarketSnapshotRecord;
    assertSnapshotIntegrity(parsed, snapshotId);
    reassessStoredQuality(parsed);
    memoryCatalog.set(path, { raw, record: parsed });
    return structuredClone(parsed);
  } catch (error) {
    memoryCatalog.delete(path);
    if (error instanceof MarketSnapshotIntegrityError) throw error;
    throw new MarketSnapshotIntegrityError(snapshotId, "record_invalid");
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

  const symbols = [...new Set((params.symbols ?? []).map((s) => s.trim()).filter(Boolean))];
  if (symbols.length === 0) throw new Error("missing_symbol: market.snapshot.get requires symbols");

  const purpose: SnapshotPurpose = params.purpose ?? "research";
  const timeframe = (params.timeframe ?? "1d").trim().toLowerCase() || "1d";
  const limit = Math.max(1, Math.min(Number(params.limit ?? 120), 500));
  const asOfMs = params.asOf === undefined ? Date.now() : pointInTimeMillis(params.asOf);
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
    if (
      purpose === "backtest" &&
      resolved.market === "UNKNOWN" &&
      resolved.confidence === "fallback"
    ) {
      errors.push(`${symbol}:missing_market_resolution`);
      continue;
    }
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

  if (
    instruments.every(
      (i) => (barsByInstrument[instrumentKey(i.symbol, i.venue)] ?? []).length === 0
    )
  ) {
    throw new Error(`market_snapshot_empty:${errors.join(";") || "no bars returned for universe"}`);
  }
  if (purpose === "backtest" && instruments.length === 0) {
    throw new Error(`missing_market_resolution:${errors.join(";") || "no resolvable symbols"}`);
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
    calendarVersion: params.calendarVersion,
    calendarSessionsByVenue: params.calendarSessionsByVenue,
    calendarSessionWindowsByVenue: params.calendarSessionWindowsByVenue,
    universeHistory: params.universeHistory,
    corporateActionLedger: params.corporateActionLedger,
    fundamentalLedger: params.fundamentalLedger,
    riskExposureLedger: params.riskExposureLedger,
    derivativePricingLedger: params.derivativePricingLedger,
  });

  const existing = await getMarketSnapshotById(record.snapshot.snapshotId, options?.dataDir);
  if (existing) return toToolResult(existing, true);

  const persisted = await persistRecord(record, options?.dataDir);
  return toToolResult(persisted, false);
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
    dataset_snapshot_id: record.snapshot.snapshotId,
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
