/**
 * Execution evidence binding (Prime D5).
 * Forces thesis + snapshot coherence for gated/live intents and portfolio construct.
 */

import {
  type OrderDataQualityGateResult,
  evaluateOrderDataQualityGate,
} from "./order-data-quality-gate";
import { getResearchThesisById } from "./research-thesis-service";

export function isOrderThesisBindingEnabled(): boolean {
  const raw = (process.env.QUBIT_ORDER_REQUIRE_THESIS ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export type EvidenceBindingInput = {
  thesisId?: string | null;
  snapshotId?: string | null;
  dispatchMode: "paper" | "live" | "sim";
  requireQualityGate?: boolean;
};

export type EvidenceBindingResult =
  | {
      ok: true;
      thesisId: string | null;
      snapshotId: string | null;
      warnings: string[];
      quality: Extract<OrderDataQualityGateResult, { ok: true }>;
    }
  | {
      ok: false;
      code: string;
      reason: string;
      thesisId: string | null;
      snapshotId: string | null;
    };

/**
 * Resolve and validate thesis ↔ snapshot binding, then run the D3 quality gate.
 * Live / requireQualityGate paths fail closed when thesis binding is enabled.
 */
export async function resolveExecutionEvidenceBinding(
  input: EvidenceBindingInput,
  options?: { dataDir?: string }
): Promise<EvidenceBindingResult> {
  const warnings: string[] = [];
  const thesisId = input.thesisId?.trim() || null;
  let snapshotId = input.snapshotId?.trim() || null;
  const mustBind =
    isOrderThesisBindingEnabled() &&
    (input.requireQualityGate === true || input.dispatchMode === "live");
  // sim (券商模拟盘) 默认不强制 thesis，便于规则/因子引擎与实时 reactor 低延迟下单。
  // 仍可通过 requireQualityGate=true 打开证据绑定。

  if (mustBind && !thesisId) {
    return {
      ok: false,
      code: "thesis_required",
      reason:
        "evidence_binding: executable/live path requires thesisId (research.thesis.write first)",
      thesisId: null,
      snapshotId,
    };
  }

  if (thesisId) {
    const thesis = await getResearchThesisById(thesisId, options?.dataDir);
    if (!thesis) {
      return {
        ok: false,
        code: "thesis_not_found",
        reason: `evidence_binding:thesis_not_found:${thesisId}`,
        thesisId,
        snapshotId,
      };
    }
    const thesisSnapshot = thesis.thesis.snapshotId;
    if (snapshotId && snapshotId !== thesisSnapshot) {
      return {
        ok: false,
        code: "snapshot_thesis_mismatch",
        reason: `evidence_binding:snapshot_thesis_mismatch:${snapshotId}!=${thesisSnapshot}`,
        thesisId,
        snapshotId,
      };
    }
    if (!snapshotId) {
      snapshotId = thesisSnapshot;
      warnings.push("evidence_binding:snapshot_derived_from_thesis");
    }
  } else if (!mustBind) {
    warnings.push("evidence_binding:thesis_omitted_paper_compat");
  }

  const quality = await evaluateOrderDataQualityGate(
    {
      snapshotId,
      dispatchMode: input.dispatchMode,
      requireQualityGate: input.requireQualityGate,
    },
    options
  );

  if (!quality.ok) {
    return {
      ok: false,
      code: quality.code,
      reason: quality.reason,
      thesisId,
      snapshotId: quality.snapshotId,
    };
  }

  return {
    ok: true,
    thesisId,
    snapshotId: quality.snapshotId ?? snapshotId,
    warnings: [...warnings, ...quality.warnings],
    quality,
  };
}
