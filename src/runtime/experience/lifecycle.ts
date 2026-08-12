/**
 * Experience lifecycle for recall ranking (Host OUT of Core).
 *
 * Active / superseded / delivered artifacts must not all weigh like current constraints.
 * No schema migration: uses metadataJson.lifecycle + content heuristics.
 */

import type { Experience } from "../../types/entities";

export type ExperienceLifecycle =
  | "active"
  | "superseded"
  | "delivered_artifact"
  | "background"
  | "archived";

const LIFECYCLE_VALUES = new Set<ExperienceLifecycle>([
  "active",
  "superseded",
  "delivered_artifact",
  "background",
  "archived",
]);

/** Multiplier applied to total recall score (0 = drop). */
const LIFECYCLE_SCORE_MULT: Record<ExperienceLifecycle, number> = {
  active: 1,
  background: 0.55,
  delivered_artifact: 0.12,
  superseded: 0.05,
  archived: 0,
};

const DELIVERY_TEXT_MARKERS: RegExp[] = [
  /人肉(操盘)?说明书/,
  /人肉版/,
  /看盘手册/,
  /操盘说明书/,
  /自然语言描述/,
  /📖/,
];

const DELIVERY_SUB_KINDS = new Set([
  "playbook",
  "workflow_play",
  "iteration_summary",
  "delivery_narrative",
  "manual",
]);

export function parseLifecycle(raw: unknown): ExperienceLifecycle | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase() as ExperienceLifecycle;
  return LIFECYCLE_VALUES.has(v) ? v : null;
}

export function inferExperienceLifecycle(exp: Experience): ExperienceLifecycle {
  const meta = exp.metadataJson ?? {};
  const explicit = parseLifecycle(meta.lifecycle ?? meta.lifecycleState);
  if (explicit) return explicit;

  if (exp.validTo != null) return "archived";

  const tags = exp.tagsJson ?? [];
  if (tags.includes("superseded") || tags.includes("lifecycle:superseded")) {
    return "superseded";
  }
  if (tags.includes("delivered_artifact") || tags.includes("lifecycle:delivered_artifact")) {
    return "delivered_artifact";
  }

  if (DELIVERY_SUB_KINDS.has(exp.subKind)) {
    return "delivered_artifact";
  }

  const summary = String(exp.contentJson?.summary ?? "");
  const body = String(exp.contentJson?.body ?? "");
  const hay = `${summary}\n${body}`;
  if (hay.length > 200 && DELIVERY_TEXT_MARKERS.some((re) => re.test(hay))) {
    return "delivered_artifact";
  }

  return "active";
}

/**
 * Apply lifecycle weighting. Returns null when the hit should be dropped from default recall.
 */
export function applyLifecycleToScore(exp: Experience, score: number): number | null {
  const life = inferExperienceLifecycle(exp);
  const mult = LIFECYCLE_SCORE_MULT[life];
  if (mult <= 0) return null;
  if (mult >= 1) return score;
  return score * mult;
}

export function isDefaultRecallExcluded(exp: Experience): boolean {
  return applyLifecycleToScore(exp, 1) === null;
}
