/**
 * K 线请求缓存 — 消除同一 workflow 内 MSA 预取 + ReAct fetch_klines 重复拉数（C 类冗余）。
 *
 * 两级 key：
 *   1. workflow 级：`${workflowRunId}:${queryKey}` — 同一次研究 run 内复用
 *   2. 进程级：`global:${queryKey}` — 无 workflow 上下文时的短 TTL 复用
 */

import type { BarData } from "../../connectors/data/data.connector";
import type { KlinesDataSourceMeta } from "./klines-data-source";

const WORKFLOW_TTL_MS = 30 * 60 * 1000;
const GLOBAL_TTL_MS = 90 * 1000;
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
  const entry: CacheEntry = {
    bars,
    expiresAt: now + GLOBAL_TTL_MS,
    ...(source ? { source } : {}),
  };
  store.set(`global:${queryKey}`, entry);
  if (workflowRunId?.trim()) {
    store.set(`${workflowRunId.trim()}:${queryKey}`, {
      bars,
      expiresAt: now + WORKFLOW_TTL_MS,
      ...(source ? { source } : {}),
    });
  }
  pruneIfNeeded();
}

export function getCachedKlinesSource(
  queryKey: string,
  workflowRunId?: string | null
): KlinesDataSourceMeta | undefined {
  const key = workflowRunId?.trim()
    ? `${workflowRunId.trim()}:${queryKey}`
    : `global:${queryKey}`;
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
