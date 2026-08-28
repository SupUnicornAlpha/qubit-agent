/**
 * TS WorkingMemory（camelCase）→ Core protocol JSON（snake_case）。
 * 仅做字段映射，不含 DB / 业务逻辑。
 */
import type { WorkingClaim, WorkingDebate, WorkingMemory } from "./types";

/** Rust `qubit_protocol::WorkingMemory` 的 wire 形状（snake_case）。 */
export interface ProtocolWorkingMemory {
  version: number;
  hypotheses: Array<{
    id: string;
    text: string;
    stance?: string;
    symbols: string[];
    evidence_refs: string[];
    confidence?: number;
    status: string;
  }>;
  open_questions: string[];
  decisions: string[];
  debate?: {
    bull_points: string[];
    bear_points: string[];
    resolution?: string;
  };
  finance_refs: {
    factor_ids: string[];
    composition_ids: string[];
    evaluation_ids: string[];
    symbols: string[];
  };
  trail_stub: Array<{
    step: number;
    tool?: string;
    ok: boolean;
    one_liner: string;
  }>;
  updated_at: string;
}

function mapClaim(c: WorkingClaim) {
  return {
    id: c.id,
    text: c.text,
    ...(c.stance ? { stance: c.stance } : {}),
    symbols: c.symbols ?? [],
    evidence_refs: c.evidenceRefs ?? [],
    ...(c.confidence != null ? { confidence: c.confidence } : {}),
    status: c.status,
  };
}

function mapDebate(d: WorkingDebate) {
  return {
    bull_points: d.bullPoints ?? [],
    bear_points: d.bearPoints ?? [],
    ...(d.resolution ? { resolution: d.resolution } : {}),
  };
}

export function toProtocolWorkingMemory(wm: WorkingMemory): ProtocolWorkingMemory {
  const refs = wm.financeRefs ?? {};
  return {
    version: wm.version,
    hypotheses: wm.hypotheses.map(mapClaim),
    open_questions: wm.openQuestions ?? [],
    decisions: wm.decisions ?? [],
    ...(wm.debate ? { debate: mapDebate(wm.debate) } : {}),
    finance_refs: {
      factor_ids: refs.factorIds ?? [],
      composition_ids: refs.compositionIds ?? [],
      evaluation_ids: refs.evaluationIds ?? [],
      symbols: refs.symbols ?? [],
    },
    trail_stub: (wm.trailStub ?? []).map((t) => ({
      step: t.step,
      ...(t.tool ? { tool: t.tool } : {}),
      ok: t.ok,
      one_liner: t.oneLiner,
    })),
    updated_at: wm.updatedAt,
  };
}
