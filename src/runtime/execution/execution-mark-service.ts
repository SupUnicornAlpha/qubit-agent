import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { dailyMarkPrice, executionMarkPrice } from "../../db/sqlite/schema";

const DEFAULT_FRESHNESS_MS = 5 * 60_000;

export interface ExecutionMark {
  price: number;
  observedAt: string;
  fetchedAt: string;
  source: string;
  timeframe: string;
  freshness: "realtime" | "eod_fallback";
}

export function normalizeExecutionMarket(exchange: string): string {
  const normalized = exchange.trim().toUpperCase();
  if (normalized === "US" || normalized === "HK" || normalized === "CRYPTO") return normalized;
  return "CN";
}

export async function recordExecutionMark(
  db: DbClient,
  input: {
    market: string;
    symbol: string;
    price: number;
    observedAt: string;
    timeframe: string;
    source: string;
    fetchedAt?: string;
  },
): Promise<void> {
  if (!Number.isFinite(input.price) || input.price <= 0) return;
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const values = {
    id: randomUUID(),
    market: input.market.trim().toUpperCase(),
    symbol: input.symbol.trim().toUpperCase(),
    price: input.price,
    observedAt: input.observedAt,
    timeframe: input.timeframe,
    source: input.source,
    fetchedAt,
  };
  await db.insert(executionMarkPrice).values(values).onConflictDoUpdate({
    target: [executionMarkPrice.market, executionMarkPrice.symbol],
    set: {
      price: values.price,
      observedAt: values.observedAt,
      timeframe: values.timeframe,
      source: values.source,
      fetchedAt: values.fetchedAt,
    },
  });
}

export async function resolveExecutionMark(
  db: DbClient,
  input: { market?: string | null; symbol: string; nowIso: string; freshnessMs?: number },
): Promise<ExecutionMark | null> {
  const symbol = input.symbol.trim().toUpperCase();
  const market = input.market?.trim().toUpperCase();
  const realtime = await db.select().from(executionMarkPrice)
    .where(and(
      eq(executionMarkPrice.symbol, symbol),
      market ? eq(executionMarkPrice.market, market) : undefined,
    ))
    .orderBy(desc(executionMarkPrice.fetchedAt))
    .limit(1);
  const latest = realtime[0];
  const freshnessMs = Math.max(1_000, input.freshnessMs ?? DEFAULT_FRESHNESS_MS);
  if (latest && Date.parse(input.nowIso) - Date.parse(latest.fetchedAt) <= freshnessMs) {
    return {
      price: latest.price,
      observedAt: latest.observedAt,
      fetchedAt: latest.fetchedAt,
      source: latest.source,
      timeframe: latest.timeframe,
      freshness: "realtime",
    };
  }
  const daily = await db.select().from(dailyMarkPrice)
    .where(and(
      eq(dailyMarkPrice.symbol, symbol),
      market ? eq(dailyMarkPrice.market, market) : undefined,
    ))
    .orderBy(desc(dailyMarkPrice.tradingDay), desc(dailyMarkPrice.fetchedAt))
    .limit(1);
  const fallback = daily[0];
  return fallback
    ? {
        price: fallback.close,
        observedAt: fallback.tradingDay,
        fetchedAt: fallback.fetchedAt,
        source: fallback.source,
        timeframe: "1d",
        freshness: "eod_fallback",
      }
    : null;
}
