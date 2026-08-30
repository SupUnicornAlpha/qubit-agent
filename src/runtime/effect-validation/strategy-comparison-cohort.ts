import { createHash } from "node:crypto";
import type { BacktestRequest } from "../provider/types";

export type StrategyComparisonCohort = {
  version: "strategy-comparison-cohort-v1";
  id: string;
  datasetSnapshotId: string;
  timeframe: string;
  startDate: string;
  endDate: string;
  symbols: string[];
  universe: string;
  benchmark: string | null;
  costsFingerprint: string;
};

/**
 * A strategy comparison is meaningful only if both variants saw exactly the
 * same frozen market input, OOS window, tradable universe and cost model.
 * Strategy-specific settings (signals, topN, rebalance) are deliberately not
 * part of this identity: those are what the challenger is allowed to change.
 */
export function buildStrategyComparisonCohort(
  request: Pick<
    BacktestRequest,
    "dataset" | "startDate" | "endDate" | "symbols" | "universe" | "benchmark" | "costs"
  >
): StrategyComparisonCohort {
  const costsFingerprint = sha256(stableJson(request.costs));
  const canonical = {
    version: "strategy-comparison-cohort-v1" as const,
    datasetSnapshotId: request.dataset.snapshotId,
    timeframe: request.dataset.timeframe,
    startDate: request.startDate,
    endDate: request.endDate,
    symbols: [...new Set(request.symbols.map((symbol) => symbol.trim()).filter(Boolean))].sort(),
    universe: request.universe.trim(),
    benchmark: request.benchmark?.trim() || null,
    costsFingerprint,
  };
  return {
    ...canonical,
    id: `strategy_cohort_${sha256(stableJson(canonical)).slice(0, 24)}`,
  };
}

/** Returns a cohort only when it is a valid, persisted comparison identity. */
export function readStrategyComparisonCohortId(metrics: unknown): string | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const value = (metrics as Record<string, unknown>).comparisonCohort;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && /^strategy_cohort_[a-f0-9]{24}$/.test(id) ? id : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
