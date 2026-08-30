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
  type MarketCalendarSessionsByVenue,
  type MarketCalendarSessionWindowsByVenue,
  type MarketCorporateActionLedger,
  type MarketDerivativePricingLedger,
  type MarketEventSource,
  type MarketFeedClass,
  type MarketFundamentalLedger,
  type MarketLicenseUse,
  type MarketRiskExposureLedger,
  type MarketSnapshot,
  type MarketUniverseHistory,
  MarketSnapshotSchema,
  evaluateTradability,
  hashPayload,
} from "./market-event-v2";

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
      (Object.entries(ledger.observationsBySymbol) as Array<
        [string, MarketFundamentalLedger["observationsBySymbol"][string]]
      >)
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
      (Object.entries(ledger.observationsBySymbol) as Array<
        [string, MarketRiskExposureLedger["observationsBySymbol"][string]]
      >)
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
  window: { start?: string; end?: string };
  sources: MarketEventSource[];
  sourceRevisions: Record<string, number>;
  adjustMethod: string;
  timezone: string;
  calendarVersion?: string;
  calendarSessionsByVenue?: MarketCalendarSessionsByVenue;
  calendarSessionWindowsByVenue?: MarketCalendarSessionWindowsByVenue;
  universeHistory?: MarketUniverseHistory;
  corporateActionLedger?: MarketCorporateActionLedger;
  fundamentalLedger?: MarketFundamentalLedger;
  riskExposureLedger?: MarketRiskExposureLedger;
  derivativePricingLedger?: MarketDerivativePricingLedger;
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
  const asOfMs = Date.parse(input.asOf);
  const lastMs = lastTs ? Date.parse(lastTs) : Number.NaN;
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
  calendarSessionsByVenue?: MarketCalendarSessionsByVenue;
  calendarSessionWindowsByVenue?: MarketCalendarSessionWindowsByVenue;
  universeHistory?: MarketUniverseHistory;
  corporateActionLedger?: MarketCorporateActionLedger;
  fundamentalLedger?: MarketFundamentalLedger;
  riskExposureLedger?: MarketRiskExposureLedger;
  derivativePricingLedger?: MarketDerivativePricingLedger;
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
  const calendarSessionsByVenue =
    canonicalCalendarSessions(input.calendarSessionsByVenue) ?? undefined;
  const calendarSessionWindowsByVenue =
    canonicalCalendarSessionWindows(input.calendarSessionWindowsByVenue) ?? undefined;
  const universeHistory = canonicalUniverseHistory(input.universeHistory);
  const corporateActionLedger = canonicalCorporateActionLedger(input.corporateActionLedger);
  const fundamentalLedger = canonicalFundamentalLedger(input.fundamentalLedger);
  const riskExposureLedger = canonicalRiskExposureLedger(input.riskExposureLedger);
  const derivativePricingLedger = canonicalDerivativePricingLedger(input.derivativePricingLedger);
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
    calendarSessionsByVenue,
    calendarSessionWindowsByVenue,
    universeHistory,
    corporateActionLedger,
    fundamentalLedger,
    riskExposureLedger,
    derivativePricingLedger,
    barDigests,
    timeframe: input.timeframe,
    limit: input.limit,
  });
  const snapshotId = snapshotIdFromFingerprint(canonical);
  const primary = input.instruments[0]!;
  const primaryBars = input.barsByInstrument[instrumentKey(primary.symbol, primary.venue)] ?? [];
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
    universeHistory,
    corporateActionLedger,
    fundamentalLedger,
    riskExposureLedger,
    derivativePricingLedger,
    timezone,
    calendarVersion: input.calendarVersion,
    calendarSessionsByVenue,
    calendarSessionWindowsByVenue,
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

  const symbols = [...new Set((params.symbols ?? []).map((s) => s.trim()).filter(Boolean))];
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
