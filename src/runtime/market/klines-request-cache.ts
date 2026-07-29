/**
 * K 线请求缓存 — 消除同一 workflow 内 MSA 预取 + ReAct fetch_klines 重复拉数（C 类冗余）。
 *
 * 两级 key：
 *   1. workflow 级：`${workflowRunId}:${queryKey}` — 同一次研究 run 内复用
 *   2. 进程级：`global:${queryKey}` — 无 workflow 上下文时的短 TTL 复用
 */

import type { BarData } from "../../connectors/data/data.connector";
import type { KlinesDataSourceMeta } from "./klines-data-source";

const HISTORICAL_WORKFLOW_TTL_MS = 30 * 60 * 1000;
const HISTORICAL_GLOBAL_TTL_MS = 90 * 1000;
const LIVE_WINDOW_WORKFLOW_TTL_MS = 15 * 1000;
const LIVE_WINDOW_GLOBAL_TTL_MS = 5 * 1000;
const LIVE_WINDOW_MS = 36 * 60 * 60 * 1000;
const MAX_ENTRIES = 512;

type CacheEntry = { bars: BarData[]; expiresAt: number; source?: KlinesDataSourceMeta };

const store = new Map<string, CacheEntry>();

function pruneIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
    if (store.size <= MAX_ENTRIES * 0.8) break;
  }
  if (store.size > MAX_ENTRIES) {
    const drop = store.size - MAX_ENTRIES;
    let i = 0;
    for (const k of store.keys()) {
      store.delete(k);
      if (++i >= drop) break;
    }
  }
}

export function buildKlinesQueryKey(params: {
  symbol: string;
  exchange?: string;
  period: string;
  startDate: string;
  endDate: string;
}): string {
  return [
    params.symbol.trim().toUpperCase(),
    (params.exchange ?? "").trim().toUpperCase(),
    params.period,
    params.startDate,
    params.endDate,
  ].join("|");
}

function parseQueryKey(queryKey: string): { period: string; endMs: number } | null {
  const parts = queryKey.split("|");
  if (parts.length < 5) return null;
  const period = parts.at(-3) ?? "";
  const endMs = Date.parse(parts.at(-1) ?? "");
  return Number.isFinite(endMs) ? { period, endMs } : null;
}

export function resolveKlinesCacheTtlMs(
  queryKey: string,
  now = Date.now()
): { global: number; workflow: number; liveWindow: boolean } {
  const parsed = parseQueryKey(queryKey);
  const liveWindow =
    Boolean(parsed) &&
    (parsed?.period !== "1d" || Math.abs(now - (parsed?.endMs ?? 0)) <= LIVE_WINDOW_MS);
  return liveWindow
    ? {
        global: LIVE_WINDOW_GLOBAL_TTL_MS,
        workflow: LIVE_WINDOW_WORKFLOW_TTL_MS,
        liveWindow: true,
      }
    : {
        global: HISTORICAL_GLOBAL_TTL_MS,
        workflow: HISTORICAL_WORKFLOW_TTL_MS,
        liveWindow: false,
      };
}

/**
 * Do not pin an incomplete current-session response in cache. This is the exact
 * Monday failure mode where a "successful" daily request only contains Friday.
 */
export function shouldCacheKlinesBars(
  queryKey: string,
  bars: BarData[],
  now = Date.now()
): boolean {
  if (bars.length === 0) return false;
  const ttl = resolveKlinesCacheTtlMs(queryKey, now);
  if (!ttl.liveWindow) return true;
  const latestMs = Math.max(
    ...bars.map((bar) => Date.parse(bar.timestamp)).filter(Number.isFinite)
  );
  return Number.isFinite(latestMs) && now - latestMs <= LIVE_WINDOW_MS;
}

export function getCachedKlinesBars(
  queryKey: string,
  workflowRunId?: string | null
): BarData[] | undefined {
  const now = Date.now();
  if (workflowRunId?.trim()) {
    const wfKey = `${workflowRunId.trim()}:${queryKey}`;
    const hit = store.get(wfKey);
    if (hit && hit.expiresAt > now) return hit.bars;
    return undefined;
  }
  const globalKey = `global:${queryKey}`;
  const globalHit = store.get(globalKey);
  if (globalHit && globalHit.expiresAt > now) return globalHit.bars;
  return undefined;
}

export function setCachedKlinesBars(
  queryKey: string,
  bars: BarData[],
  workflowRunId?: string | null,
  source?: KlinesDataSourceMeta
): void {
  const now = Date.now();
  if (!shouldCacheKlinesBars(queryKey, bars, now)) return;
  const ttl = resolveKlinesCacheTtlMs(queryKey, now);
  const entry: CacheEntry = {
    bars,
    expiresAt: now + ttl.global,
    ...(source ? { source } : {}),
  };
  store.set(`global:${queryKey}`, entry);
  if (workflowRunId?.trim()) {
    store.set(`${workflowRunId.trim()}:${queryKey}`, {
      bars,
      expiresAt: now + ttl.workflow,
      ...(source ? { source } : {}),
    });
  }
  pruneIfNeeded();
}

export function getCachedKlinesSource(
  queryKey: string,
  workflowRunId?: string | null
): KlinesDataSourceMeta | undefined {
  const key = workflowRunId?.trim() ? `${workflowRunId.trim()}:${queryKey}` : `global:${queryKey}`;
  const hit = store.get(key);
  if (!hit || hit.expiresAt <= Date.now()) return undefined;
  return hit.source;
}

/** 测试 / workflow 结束时清理 */
export function clearKlinesRequestCache(workflowRunId?: string): void {
  if (!workflowRunId?.trim()) {
    store.clear();
    return;
  }
  const prefix = `${workflowRunId.trim()}:`;
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}
