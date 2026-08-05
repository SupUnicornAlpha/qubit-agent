/**
 * D1 side-path mirror: convert live MarketStreamEvent → MarketEvent v2
 * into an in-memory append-only journal. Failures never affect the user path.
 */

import { resolveTickerMarket } from "../resolve-ticker-market";
import {
  type MarketAssetClass,
  type MarketEventKind,
  type MarketEventV2,
  type MarketFeedClass,
  type MarketLicenseUse,
  MARKET_EVENT_SCHEMA_VERSION,
  MarketEventSchema,
  hashPayload,
  newMarketEventId,
} from "./market-event-v2";

/** Minimal stream event shape — avoids circular import with market-stream-gateway. */
export type MarketStreamMirrorKind =
  | "status"
  | "heartbeat"
  | "quote"
  | "order_book"
  | "trade"
  | "bar"
  | "backfill";

export interface MarketStreamMirrorInput {
  kind: MarketStreamMirrorKind;
  sequence: number;
  symbol: string;
  exchange: string;
  timeframe: string;
  source: string;
  emittedAt: string;
  data: unknown;
}
export interface MarketEventMirrorMetrics {
  mirrored: number;
  skipped: number;
  errors: number;
  lastError: string | null;
  lastMirroredAt: string | null;
}

export interface MarketEventMirrorJournal {
  append(event: MarketEventV2): void;
  recordSkip(): void;
  recordError(error: unknown): void;
  recent(limit?: number): MarketEventV2[];
  clear(): void;
  size(): number;
  metrics(): MarketEventMirrorMetrics;
}

const DEFAULT_CAPACITY = 4_096;

export function createMarketEventMirrorJournal(capacity = DEFAULT_CAPACITY): MarketEventMirrorJournal {
  const buffer: MarketEventV2[] = [];
  const metrics: MarketEventMirrorMetrics = {
    mirrored: 0,
    skipped: 0,
    errors: 0,
    lastError: null,
    lastMirroredAt: null,
  };

  return {
    append(event) {
      buffer.push(event);
      if (buffer.length > capacity) buffer.shift();
      metrics.mirrored += 1;
      metrics.lastMirroredAt = event.ingestedAt;
    },
    recordSkip() {
      metrics.skipped += 1;
    },
    recordError(error) {
      metrics.errors += 1;
      metrics.lastError = error instanceof Error ? error.message : String(error);
    },
    recent(limit = 50) {
      if (limit <= 0) return [];
      return buffer.slice(-limit);
    },
    clear() {
      buffer.length = 0;
      metrics.mirrored = 0;
      metrics.skipped = 0;
      metrics.errors = 0;
      metrics.lastError = null;
      metrics.lastMirroredAt = null;
    },
    size() {
      return buffer.length;
    },
    metrics() {
      return { ...metrics };
    },
  };
}

export const marketEventMirrorJournal = createMarketEventMirrorJournal();

function isMirrorEnabled(): boolean {
  const raw = (process.env.QUBIT_MARKET_EVENT_MIRROR ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

function mapKind(kind: MarketStreamMirrorKind): MarketEventKind | null {
  switch (kind) {
    case "quote":
      return "quote";
    case "trade":
      return "trade";
    case "order_book":
      return "book_delta";
    case "bar":
    case "backfill":
      return "bar";
    case "status":
      return "status";
    case "heartbeat":
      return null;
    default:
      return null;
  }
}

function inferAssetClass(symbol: string, venue: string): MarketAssetClass {
  const market = resolveTickerMarket(symbol, { hintExchange: venue }).market;
  if (market === "CRYPTO") return "crypto";
  if (market === "US" || market === "CN" || market === "HK") return "equity";
  return "unknown";
}

function inferFeedMeta(provider: string): {
  feed: string;
  upstreamFamily: string;
  feedClass: MarketFeedClass;
  licenseUse: MarketLicenseUse;
} {
  const id = provider.trim().toLowerCase();
  if (id.includes("binance")) {
    return {
      feed: "venue_websocket",
      upstreamFamily: "binance",
      feedClass: "L2_realtime_observe",
      licenseUse: "observe_only",
    };
  }
  if (
    id.includes("futu") ||
    id.includes("ib") ||
    id.includes("supermind") ||
    id.includes("ths")
  ) {
    const upstreamFamily = id.includes("futu")
      ? "futu"
      : id.includes("supermind") || id.includes("ths")
        ? "supermind"
        : "ib";
    return {
      feed: "broker_market_bridge",
      upstreamFamily,
      feedClass: "L2_realtime_observe",
      licenseUse: "observe_only",
    };
  }
  if (id.includes("wind")) {
    return {
      feed: "licensed_terminal",
      upstreamFamily: "wind",
      feedClass: "L1_strategy_validation",
      licenseUse: "research_only",
    };
  }
  if (id.includes("eastmoney") || id.includes("tencent") || id.includes("akshare")) {
    return {
      feed: "public_aggregate",
      upstreamFamily: id.includes("tencent") ? "tencent" : "eastmoney",
      feedClass: "L0_research_fallback",
      licenseUse: "research_only",
    };
  }
  return {
    feed: "stream_or_poll",
    upstreamFamily: id || "unknown",
    feedClass: "L0_research_fallback",
    licenseUse: "research_only",
  };
}

function asRecord(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

function pickEventTs(data: Record<string, unknown>, fallback: string): string {
  const candidates = [data.timestamp, data.eventTs, data.time, data.ts];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value).toISOString();
    }
  }
  return fallback;
}

function pickFreshnessMs(
  data: Record<string, unknown>,
  eventTs: string,
  recvTs: string
): number | null {
  const explicit = Number(data.freshnessMs);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const eventMs = Date.parse(eventTs);
  const recvMs = Date.parse(recvTs);
  if (Number.isFinite(eventMs) && Number.isFinite(recvMs)) {
    return Math.max(0, recvMs - eventMs);
  }
  return null;
}

function qualityStateFor(
  kind: MarketEventKind,
  data: Record<string, unknown>,
  freshnessMs: number | null
): MarketEventV2["quality"]["state"] {
  if (kind === "gap" || kind === "status") {
    const status = typeof data.status === "string" ? data.status : "";
    if (status.includes("gap") || kind === "gap") return "gap_pending";
  }
  if (freshnessMs != null && freshnessMs > 30_000) return "stale";
  return "observed";
}

export function marketStreamEventToMarketEventV2(
  streamEvent: MarketStreamMirrorInput
): MarketEventV2 | null {
  const kind = mapKind(streamEvent.kind);
  if (!kind) return null;

  const payload = asRecord(streamEvent.data);
  if (kind === "status") {
    const status = typeof payload.status === "string" ? payload.status : "";
    if (!status.includes("gap") && status !== "backfill_failed") return null;
  }

  const recvTs = streamEvent.emittedAt;
  const eventTs = pickEventTs(payload, recvTs);
  const freshnessMs = pickFreshnessMs(payload, eventTs, recvTs);
  const venue =
    (typeof payload.exchange === "string" && payload.exchange.trim()) ||
    streamEvent.exchange ||
    "UNKNOWN";
  const symbol =
    (typeof payload.symbol === "string" && payload.symbol.trim()) || streamEvent.symbol;
  const feedMeta = inferFeedMeta(streamEvent.source);
  const mappedKind: MarketEventKind = kind === "status" ? "gap" : kind;
  const channel = `${mappedKind}:${venue}:${symbol}`;

  const candidate = {
    eventId: newMarketEventId(),
    kind: mappedKind,
    instrument: {
      symbol,
      venue,
      assetClass: inferAssetClass(symbol, venue),
    },
    eventTs,
    recvTs,
    source: {
      provider: streamEvent.source || "unknown",
      feed: feedMeta.feed,
      upstreamFamily: feedMeta.upstreamFamily,
      feedClass: feedMeta.feedClass,
      licenseUse: feedMeta.licenseUse,
    },
    sequence: {
      channel,
      value: streamEvent.sequence,
      isContiguous: true,
      providerSequenceAvailable: false,
    },
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
    payload: {
      ...payload,
      streamKind: streamEvent.kind,
      timeframe: streamEvent.timeframe,
    },
    rawPayloadHash: hashPayload(streamEvent.data),
    quality: {
      state: qualityStateFor(mappedKind, payload, freshnessMs),
      freshnessMs,
      revision: 0,
    },
    ingestedAt: new Date().toISOString(),
  };

  return MarketEventSchema.parse(candidate);
}

export function mirrorMarketStreamEvent(
  streamEvent: MarketStreamMirrorInput,
  journal: MarketEventMirrorJournal = marketEventMirrorJournal
): MarketEventV2 | null {
  if (!isMirrorEnabled()) {
    journal.recordSkip();
    return null;
  }

  try {
    const event = marketStreamEventToMarketEventV2(streamEvent);
    if (!event) {
      journal.recordSkip();
      return null;
    }
    journal.append(event);
    return event;
  } catch (error) {
    journal.recordError(error);
    return null;
  }
}

/** Gateway entry — never throws. */
export function safeMirrorMarketStreamEvent(streamEvent: MarketStreamMirrorInput): void {
  try {
    mirrorMarketStreamEvent(streamEvent, marketEventMirrorJournal);
  } catch (error) {
    marketEventMirrorJournal.recordError(error);
  }
}
