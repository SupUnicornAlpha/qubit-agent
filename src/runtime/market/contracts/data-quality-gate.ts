/**
 * Data quality assessments (Prime D3).
 * Pure functions — no snapshot catalog I/O (avoids circular imports).
 */

import type { DataQualityVerdict, MarketEventSource } from "./market-event-v2";

export type ConsistencyAssessment = DataQualityVerdict["consistency"];

export function isMarketQualityGateEnabled(): boolean {
  const raw = (process.env.QUBIT_MARKET_QUALITY_GATE ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** Same upstreamFamily cannot count as independent redundancy (Q3). */
export function assessUpstreamIndependence(
  sources: Array<Pick<MarketEventSource, "upstreamFamily">>
): ConsistencyAssessment {
  const families = [
    ...new Set(sources.map((s) => s.upstreamFamily.trim().toLowerCase()).filter(Boolean)),
  ];
  if (families.length <= 1) return "insufficient_peers";
  return "verified";
}

/**
 * Cross-source price divergence. Threshold is relative (e.g. 0.005 = 0.5%).
 * Same upstream → insufficient_peers (never "verified").
 */
export function assessPriceDivergence(
  peers: Array<{ upstreamFamily: string; price: number }>,
  thresholdPct = Number(process.env.QUBIT_SOURCE_DIVERGENCE_PCT ?? "0.005")
): ConsistencyAssessment {
  const usable = peers.filter(
    (p) => Number.isFinite(p.price) && p.price > 0 && p.upstreamFamily.trim()
  );
  if (usable.length < 2) return "insufficient_peers";

  const families = [...new Set(usable.map((p) => p.upstreamFamily.trim().toLowerCase()))];
  if (families.length < 2) return "insufficient_peers";

  const byFamily = new Map<string, number[]>();
  for (const peer of usable) {
    const key = peer.upstreamFamily.trim().toLowerCase();
    byFamily.set(key, [...(byFamily.get(key) ?? []), peer.price]);
  }
  const familyMids = [...byFamily.values()].map(
    (prices) => prices.reduce((a, b) => a + b, 0) / prices.length
  );
  const mid = familyMids.reduce((a, b) => a + b, 0) / familyMids.length;
  if (!(mid > 0)) return "insufficient_peers";

  const maxDev = Math.max(...familyMids.map((p) => Math.abs(p - mid) / mid));
  const threshold = Number.isFinite(thresholdPct) && thresholdPct > 0 ? thresholdPct : 0.005;
  return maxDev > threshold ? "divergent" : "verified";
}
