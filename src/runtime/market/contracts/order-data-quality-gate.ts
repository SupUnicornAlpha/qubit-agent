/**
 * Order-path data quality gate (Prime D3).
 * Fail-closed for live/executable intents; paper may omit snapshot with a warning.
 */

import type { DataQualityVerdict } from "./market-event-v2";
import { evaluateTradability } from "./market-event-v2";
import { assessUpstreamIndependence, isMarketQualityGateEnabled } from "./data-quality-gate";
import {
  getMarketSnapshotById,
  type MarketSnapshotRecord,
} from "./market-snapshot-service";

export type OrderDataQualityGateInput = {
  snapshotId?: string | null;
  dispatchMode: "paper" | "live" | "sim";
  /** Force snapshot+tradable even for paper/sim (auto strategies / explicit callers). */
  requireQualityGate?: boolean;
};

export type OrderDataQualityGateResult =
  | {
      ok: true;
      snapshotId: string | null;
      verdict: DataQualityVerdict | null;
      warnings: string[];
      record: MarketSnapshotRecord | null;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      snapshotId: string | null;
      verdict: DataQualityVerdict | null;
    };

export async function evaluateOrderDataQualityGate(
  input: OrderDataQualityGateInput,
  options?: { dataDir?: string }
): Promise<OrderDataQualityGateResult> {
  const warnings: string[] = [];
  const snapshotId = input.snapshotId?.trim() || null;
  const mustHaveSnapshot =
    input.requireQualityGate === true || input.dispatchMode === "live";

  if (!isMarketQualityGateEnabled()) {
    if (snapshotId) {
      const record = await getMarketSnapshotById(snapshotId, options?.dataDir);
      return {
        ok: true,
        snapshotId,
        verdict: record?.snapshot.qualityVerdict ?? null,
        warnings: ["data_quality_gate_disabled"],
        record,
      };
    }
    return {
      ok: true,
      snapshotId: null,
      verdict: null,
      warnings: ["data_quality_gate_disabled"],
      record: null,
    };
  }

  if (!snapshotId) {
    if (mustHaveSnapshot) {
      return {
        ok: false,
        code: "snapshot_required",
        reason:
          "data_quality_gate: executable/live order requires snapshotId with tradable=true",
        snapshotId: null,
        verdict: null,
      };
    }
    warnings.push("data_quality:snapshot_omitted_paper_compat");
    return { ok: true, snapshotId: null, verdict: null, warnings, record: null };
  }

  const record = await getMarketSnapshotById(snapshotId, options?.dataDir);
  if (!record) {
    return {
      ok: false,
      code: "snapshot_not_found",
      reason: `data_quality_gate:snapshot_not_found:${snapshotId}`,
      snapshotId,
      verdict: null,
    };
  }

  const verdict =
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
      consistency: assessUpstreamIndependence(record.snapshot.sources),
      structure: "valid",
      pointInTime: "point_in_time_valid",
      licenseUse: record.snapshot.sources[0]?.licenseUse ?? "research_only",
      snapshotId,
    });

  if (!verdict.tradable) {
    return {
      ok: false,
      code: "not_tradable",
      reason: `data_quality_gate:not_tradable:${verdict.useClass}:${verdict.reasons.join(",") || "unspecified"}`,
      snapshotId,
      verdict,
    };
  }

  return { ok: true, snapshotId, verdict, warnings, record };
}

export async function assertTradableSnapshotForOrder(
  input: OrderDataQualityGateInput,
  options?: { dataDir?: string }
): Promise<{
  snapshotId: string | null;
  verdict: DataQualityVerdict | null;
  warnings: string[];
}> {
  const result = await evaluateOrderDataQualityGate(input, options);
  if (!result.ok) {
    throw new Error(`${result.code}:${result.reason}`);
  }
  return {
    snapshotId: result.snapshotId,
    verdict: result.verdict,
    warnings: result.warnings,
  };
}
