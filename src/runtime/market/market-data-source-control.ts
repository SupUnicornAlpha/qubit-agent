import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { marketDataSource, marketDataSourceCall } from "../../db/sqlite/schema";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import type { MarketCode } from "./resolve-ticker-market";
import type { KlinesDataSourceMeta, KlinesDataSourceSetting } from "./klines-data-source";

export type OperationalMarketDataSource = Exclude<KlinesDataSourceMeta, "synthetic">;

export type MarketSourceHealth = "unknown" | "healthy" | "degraded" | "down";
export type MarketSourceCircuit = "closed" | "open" | "half_open";

export interface MarketDataSourceDefinition {
  id: OperationalMarketDataSource;
  name: string;
  vendor: string;
  markets: MarketCode[];
  timeframes: string[];
  credentialMode: "none" | "token" | "account" | "terminal";
  priority: number;
  isFallback: boolean;
}

export const MARKET_DATA_SOURCE_DEFINITIONS: MarketDataSourceDefinition[] = [
  {
    id: "wind",
    name: "Wind Financial Terminal",
    vendor: "Wind",
    markets: ["CN", "HK"],
    timeframes: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
    credentialMode: "terminal",
    priority: 95,
    isFallback: false,
  },
  {
    id: "tushare_daily",
    name: "Tushare Pro",
    vendor: "Tushare",
    markets: ["CN"],
    timeframes: ["1d"],
    credentialMode: "token",
    priority: 90,
    isFallback: false,
  },
  {
    id: "binance_crypto",
    name: "Binance Market Data",
    vendor: "Binance",
    markets: ["CRYPTO"],
    timeframes: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
    credentialMode: "none",
    priority: 85,
    isFallback: false,
  },
  {
    id: "eastmoney",
    name: "EastMoney Kline",
    vendor: "东方财富",
    markets: ["CN"],
    timeframes: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
    credentialMode: "none",
    priority: 75,
    isFallback: true,
  },
  {
    id: "akshare",
    name: "AKShare",
    vendor: "AKShare",
    markets: ["CN", "HK"],
    timeframes: ["1m", "5m", "15m", "30m", "1h", "1d"],
    credentialMode: "none",
    priority: 65,
    isFallback: true,
  },
  {
    id: "yfinance",
    name: "yfinance Python",
    vendor: "Yahoo Finance",
    markets: ["US", "HK", "CN", "JP", "UK", "DE", "FR", "CA", "AU", "KR", "TW", "SG", "IN"],
    timeframes: ["1m", "5m", "15m", "30m", "1h", "1d"],
    credentialMode: "none",
    priority: 55,
    isFallback: true,
  },
  {
    id: "yahoo_chart",
    name: "Yahoo Chart API",
    vendor: "Yahoo Finance",
    markets: ["US", "HK", "CN", "JP", "UK", "DE", "FR", "CA", "AU", "KR", "TW", "SG", "IN"],
    timeframes: ["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
    credentialMode: "none",
    priority: 40,
    isFallback: true,
  },
];

const DEF_BY_ID = new Map(MARKET_DATA_SOURCE_DEFINITIONS.map((d) => [d.id, d]));
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 60_000;

function credentialsReady(def: MarketDataSourceDefinition, settings: BuiltinConnectorInitConfigs): boolean {
  const cfg = settings["qubit-data"] ?? {};
  if (def.credentialMode === "none") return true;
  if (def.id === "tushare_daily") {
    return typeof cfg.tushareToken === "string" && cfg.tushareToken.trim().length > 0;
  }
  if (def.id === "wind") {
    return typeof cfg.windUsername === "string" && cfg.windUsername.trim().length > 0;
  }
  return false;
}

export async function bootstrapMarketDataSources(
  settings: BuiltinConnectorInitConfigs
): Promise<void> {
  const db = await getDb();
  for (const def of MARKET_DATA_SOURCE_DEFINITIONS) {
    await db
      .insert(marketDataSource)
      .values({
        id: def.id,
        name: def.name,
        sourceType: "market",
        vendor: def.vendor,
        status: "active",
        supportedMarketsJson: def.markets,
        supportedTimeframesJson: def.timeframes,
        credentialMode: def.credentialMode,
        credentialsReady: credentialsReady(def, settings),
        priority: def.priority,
        isFallback: def.isFallback,
      })
      .onConflictDoUpdate({
        target: marketDataSource.id,
        set: {
          name: def.name,
          vendor: def.vendor,
          supportedMarketsJson: def.markets,
          supportedTimeframesJson: def.timeframes,
          credentialMode: def.credentialMode,
          credentialsReady: credentialsReady(def, settings),
        },
      });
  }
}

export interface MarketDataSourceView {
  id: string;
  name: string;
  vendor: string;
  status: "active" | "inactive" | "error";
  supportedMarkets: string[];
  supportedTimeframes: string[];
  credentialMode: string;
  credentialsReady: boolean;
  healthStatus: MarketSourceHealth;
  lastHealthcheckAt: string | null;
  successRate: number | null;
  p95LatencyMs: number | null;
  lastLatencyMs: number | null;
  lastError: string | null;
  circuitState: MarketSourceCircuit;
  circuitOpenedAt: string | null;
  priority: number;
  isFallback: boolean;
}

function percentile95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
}

export async function listMarketDataSources(): Promise<MarketDataSourceView[]> {
  const db = await getDb();
  const rows = await db.select().from(marketDataSource);
  const out: MarketDataSourceView[] = [];
  for (const row of rows.filter((r) => r.sourceType === "market")) {
    const calls = await db
      .select()
      .from(marketDataSourceCall)
      .where(eq(marketDataSourceCall.sourceId, row.id))
      .orderBy(desc(marketDataSourceCall.createdAt))
      .limit(100);
    const completed = calls.filter((c) => c.status !== "blocked");
    const successes = completed.filter((c) => c.status === "success").length;
    out.push({
      id: row.id,
      name: row.name,
      vendor: row.vendor,
      status: row.status,
      supportedMarkets: Array.isArray(row.supportedMarketsJson) ? row.supportedMarketsJson as string[] : [],
      supportedTimeframes: Array.isArray(row.supportedTimeframesJson) ? row.supportedTimeframesJson as string[] : [],
      credentialMode: row.credentialMode,
      credentialsReady: row.credentialsReady,
      healthStatus: row.healthStatus,
      lastHealthcheckAt: row.lastHealthcheckAt,
      successRate: completed.length > 0 ? successes / completed.length : null,
      p95LatencyMs: percentile95(completed.map((c) => c.latencyMs)),
      lastLatencyMs: row.lastLatencyMs,
      lastError: row.lastError,
      circuitState: row.circuitState,
      circuitOpenedAt: row.circuitOpenedAt,
      priority: row.priority,
      isFallback: row.isFallback,
    });
  }
  return out.sort((a, b) => b.priority - a.priority);
}

export async function patchMarketDataSource(
  id: string,
  patch: { status?: "active" | "inactive"; priority?: number; isFallback?: boolean }
): Promise<void> {
  const db = await getDb();
  await db
    .update(marketDataSource)
    .set({
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.priority !== undefined
        ? { priority: Math.max(0, Math.min(100, Math.round(patch.priority))) }
        : {}),
      ...(patch.isFallback !== undefined ? { isFallback: patch.isFallback } : {}),
    })
    .where(eq(marketDataSource.id, id));
}

export async function recordMarketDataSourceAttempt(input: {
  sourceId: KlinesDataSourceMeta;
  market: string;
  timeframe: string;
  symbol: string;
  status: "success" | "empty" | "error" | "blocked";
  latencyMs: number;
  error?: string;
  healthcheck?: boolean;
}): Promise<void> {
  const db = await getDb();
  const current = await db
    .select()
    .from(marketDataSource)
    .where(eq(marketDataSource.id, input.sourceId))
    .limit(1);
  const row = current[0];
  if (!row) return;
  const failed = input.status === "empty" || input.status === "error";
  const consecutive = failed ? row.consecutiveFailures + 1 : 0;
  const opened = failed && consecutive >= CIRCUIT_THRESHOLD;
  const healthStatus: MarketSourceHealth =
    input.status === "success" ? "healthy" : input.status === "blocked" ? row.healthStatus : opened ? "down" : "degraded";
  await db.insert(marketDataSourceCall).values({
    id: crypto.randomUUID(),
    sourceId: input.sourceId,
    market: input.market,
    timeframe: input.timeframe,
    symbol: input.symbol,
    status: input.status,
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    errorMessage: input.error ?? null,
  });
  await db
    .update(marketDataSource)
    .set({
      healthStatus,
      ...(input.healthcheck ? { lastHealthcheckAt: new Date().toISOString() } : {}),
      lastLatencyMs: Math.max(0, Math.round(input.latencyMs)),
      successCount: row.successCount + (input.status === "success" ? 1 : 0),
      failureCount: row.failureCount + (failed ? 1 : 0),
      consecutiveFailures: consecutive,
      lastError: failed ? (input.error ?? input.status) : null,
      circuitState: opened ? "open" : input.status === "success" ? "closed" : row.circuitState,
      circuitOpenedAt: opened ? new Date().toISOString() : input.status === "success" ? null : row.circuitOpenedAt,
    })
    .where(eq(marketDataSource.id, input.sourceId));
}

export async function selectMarketDataSourcePlan(input: {
  market: MarketCode;
  timeframe: string;
  mode: KlinesDataSourceSetting;
  settings: BuiltinConnectorInitConfigs;
}): Promise<OperationalMarketDataSource[]> {
  const rows = await listMarketDataSources();
  const explicit = input.mode !== "auto" && input.mode !== "synthetic" ? input.mode : null;
  const now = Date.now();
  const eligible = rows.filter((row) => {
    if (row.status !== "active" || !row.credentialsReady) return false;
    if (!row.supportedMarkets.includes(input.market)) return false;
    if (!row.supportedTimeframes.includes(input.timeframe)) return false;
    if (row.circuitState !== "open") return true;
    const def = DEF_BY_ID.get(row.id as OperationalMarketDataSource);
    if (!def) return false;
    const openedAt = row.circuitOpenedAt ? Date.parse(row.circuitOpenedAt) : now;
    return Number.isFinite(openedAt) && now - openedAt >= CIRCUIT_COOLDOWN_MS;
  });
  const ordered = eligible.map((r) => r.id as OperationalMarketDataSource);
  if (!explicit) return ordered;
  const fallbackIds = new Set(
    eligible.filter((row) => row.isFallback).map((row) => row.id as OperationalMarketDataSource),
  );
  if (!ordered.includes(explicit as OperationalMarketDataSource)) {
    return ordered.filter((id) => fallbackIds.has(id));
  }
  return [
    explicit as OperationalMarketDataSource,
    ...ordered.filter((id) => id !== explicit && fallbackIds.has(id)),
  ];
}

export function marketSourceDefinition(id: string): MarketDataSourceDefinition | undefined {
  return DEF_BY_ID.get(id as OperationalMarketDataSource);
}
