/**
 * DecisionRecord 后验写回（05 §4.3.1 / A3→A4）
 */

import { getExperienceStore } from "../experience";
import type { ExperienceStore } from "../experience/experience-store";
import { incContextMetric } from "./context-metrics";
import type { DecisionRecordOutcome } from "./types";

export interface ApplyDecisionOutcomeInput {
  store: ExperienceStore;
  experienceId: string;
  outcome: DecisionRecordOutcome;
  /** Stable outcome identity prevents worker replays from double-counting. */
  dedupeKey?: string;
  /** 成功则 successCount++；失败 failCount++ */
  bumpCounts?: boolean;
}

/**
 * 将 outcome 写入 Experience.metadataJson.decisionRecord.outcome，
 * 并按 label 更新 success/fail 计数（驱动 A4 outcomeWeight）。
 */
export async function applyDecisionOutcome(
  input: ApplyDecisionOutcomeInput
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await input.store.findById(input.experienceId);
  if (!row) return { ok: false, reason: "experience_not_found" };

  const meta = { ...(row.metadataJson ?? {}) } as Record<string, unknown>;
  const existing =
    meta.decisionRecord && typeof meta.decisionRecord === "object"
      ? (meta.decisionRecord as Record<string, unknown>)
      : {};
  const outcomeKeys = Array.isArray(existing.outcomeKeys)
    ? existing.outcomeKeys.map(String).filter(Boolean)
    : [];
  const alreadyApplied = Boolean(input.dedupeKey && outcomeKeys.includes(input.dedupeKey));
  meta.decisionRecord = {
    ...existing,
    outcome: input.outcome,
    ...(input.dedupeKey && !alreadyApplied
      ? { outcomeKeys: [...new Set([...outcomeKeys, input.dedupeKey])].slice(-50) }
      : {}),
  };

  const patch: {
    metadataJson: Record<string, unknown>;
    successCount?: number;
    failCount?: number;
  } = { metadataJson: meta };

  if (!alreadyApplied && input.bumpCounts !== false) {
    if (input.outcome.label === "success") {
      patch.successCount = row.successCount + 1;
    } else if (input.outcome.label === "fail") {
      patch.failCount = row.failCount + 1;
    }
  }

  await input.store.update(input.experienceId, patch);
  if (alreadyApplied) return { ok: true };
  try {
    await input.store.logOp({
      experienceId: input.experienceId,
      op: "execute",
      actor: "decision_outcome",
      metadataJson: {
        outcome: input.outcome.label,
        scoredAt: input.outcome.scoredAt,
        brierContribution: input.outcome.brierContribution ?? null,
      },
    });
  } catch {
    /* op_log 失败不阻断 */
  }

  incContextMetric("finance.decision_outcome_write", 1, {
    label: input.outcome.label,
  });
  return { ok: true };
}

/** Brier 贡献：(confidence - binaryOutcome)^2；binaryOutcome: success=1, fail=0 */
export function brierContribution(
  confidence: number,
  label: DecisionRecordOutcome["label"]
): number | undefined {
  if (label !== "success" && label !== "fail") return undefined;
  const y = label === "success" ? 1 : 0;
  const c = Math.max(0, Math.min(1, confidence));
  return (c - y) ** 2;
}

export function recommendationTradeToOutcomeLabel(
  tradeOutcome: "win" | "loss" | "flat"
): DecisionRecordOutcome["label"] {
  if (tradeOutcome === "win") return "success";
  if (tradeOutcome === "loss") return "fail";
  return "partial";
}

/**
 * 推荐后验 → 写回同 project / 同标的 research_conclusion 的 DecisionRecord.outcome。
 */
export async function applyRecommendationOutcomeToExperiences(input: {
  projectId: string;
  workflowRunId: string;
  recommendationId?: string;
  horizonDays?: number;
  symbol: string;
  confidence: number;
  tradeOutcome: "win" | "loss" | "flat";
  returnPct?: number | null;
  excessReturnPct?: number | null;
  scoredAt: string;
  store?: ExperienceStore;
}): Promise<number> {
  const store = input.store ?? getExperienceStore();
  const label = recommendationTradeToOutcomeLabel(input.tradeOutcome);
  const conf = Math.max(0, Math.min(1, input.confidence));
  const brier = brierContribution(conf, label);
  const outcome: DecisionRecordOutcome = {
    label,
    scoredAt: input.scoredAt,
    ...(input.returnPct != null ? { realizedReturn: input.returnPct } : {}),
    ...(input.excessReturnPct != null ? { excessReturn: input.excessReturnPct } : {}),
    ...(brier != null ? { brierContribution: brier } : {}),
  };

  const candidates = await store.query({
    kind: "semantic",
    subKind: "research_conclusion",
    scope: "project",
    scopeId: input.projectId,
    archivalMode: "exclude_archived",
    orderBy: "created_desc",
    limit: 60,
  });

  const sym = input.symbol.toUpperCase();
  const linked: typeof candidates = [];
  for (const exp of candidates) {
    const meta = exp.metadataJson ?? {};
    const symbols = Array.isArray(meta.symbols)
      ? (meta.symbols as unknown[]).map((s) => String(s).toUpperCase())
      : [];
    const tagHit = exp.tagsJson.some(
      (t) => t.toUpperCase() === `SYMBOL:${sym}` || t.toUpperCase() === sym
    );
    const sameRun =
      exp.sourceRunId === input.workflowRunId || meta.workflowRunId === input.workflowRunId;
    const explicitRecommendationMatch =
      Boolean(input.recommendationId) && meta.recommendationId === input.recommendationId;
    // A symbol is only an additional guard. It must never be used as a causal
    // link to a different workflow's thesis/research conclusion.
    if ((sameRun || explicitRecommendationMatch) && (symbols.includes(sym) || tagHit)) {
      linked.push(exp);
    }
  }

  let updated = 0;
  const dedupeKey =
    input.recommendationId && Number.isInteger(input.horizonDays)
      ? `recommendation:${input.recommendationId}:horizon:${input.horizonDays}`
      : undefined;
  for (const exp of linked) {
    const r = await applyDecisionOutcome({
      store,
      experienceId: exp.id,
      outcome,
      dedupeKey,
    });
    if (r.ok) updated += 1;
    if (updated >= 3) break;
  }
  return updated;
}
