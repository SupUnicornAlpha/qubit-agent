/**
 * Plan timeline segments for Orchestrator chat.
 * - Progress updates (step status only) refresh the current segment card.
 * - Structural changes (mode / goal text / step ids+titles) open a new segment.
 */

import type { OrchestratorPlan } from "./PlanCard";

export type PlanTimelineSegment = {
  id: string;
  plan: OrchestratorPlan;
  /** First time this task plan appeared (anchors conversation belonging to it). */
  startedAt: string;
  updatedAt: string;
};

/** Structure fingerprint: ignores step status / notes / goal progress counters. */
export function planStructureKey(plan: OrchestratorPlan): string {
  return JSON.stringify({
    mode: plan.mode ?? "agent",
    goal: (plan.goal?.text ?? "").trim(),
    steps: (plan.steps ?? []).map((s) => ({
      id: String(s.id ?? ""),
      title: String(s.title ?? "").trim(),
    })),
  });
}

export function upsertPlanSegment(
  segments: PlanTimelineSegment[],
  next: OrchestratorPlan,
  at?: string | null
): PlanTimelineSegment[] {
  if (!next.steps?.length) return segments;
  const stamp =
    (typeof at === "string" && at.trim()) ||
    (typeof next.updatedAt === "string" && next.updatedAt.trim()) ||
    new Date().toISOString();
  const updatedAt =
    (typeof next.updatedAt === "string" && next.updatedAt.trim()) || stamp;
  const key = planStructureKey(next);
  const last = segments[segments.length - 1];
  if (last && planStructureKey(last.plan) === key) {
    return [
      ...segments.slice(0, -1),
      {
        ...last,
        plan: { ...next, updatedAt },
        updatedAt,
      },
    ];
  }
  return [
    ...segments,
    {
      id: `plan-${stamp}-${segments.length}`,
      plan: { ...next, updatedAt },
      /** May be backdated to the triggering user message. */
      startedAt: stamp,
      updatedAt,
    },
  ];
}

export function latestPlanFromSegments(
  segments: PlanTimelineSegment[]
): OrchestratorPlan | null {
  const last = segments[segments.length - 1];
  return last?.plan ?? null;
}

type RoleMessageLike = {
  kind: string;
  ts: string;
  fromRole?: string;
};

/**
 * Insert Plan between triggering user prompt and subsequent assistant/tool output:
 *   leading (…user) → PlanCard → trailing (assistant / tools …)
 */
export function splitEventsForPlanPlacement<T extends RoleMessageLike>(
  events: T[],
  planStartedAt?: string | null
): { leading: T[]; trailing: T[] } {
  if (events.length === 0) return { leading: [], trailing: [] };

  let anchorIdx = -1;
  if (planStartedAt) {
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.kind === "message" && e.fromRole === "user" && e.ts <= planStartedAt) {
        anchorIdx = i;
      }
    }
  }
  if (anchorIdx < 0) {
    anchorIdx = events.findIndex((e) => e.kind === "message" && e.fromRole === "user");
  }
  if (anchorIdx < 0) {
    return { leading: [], trailing: events };
  }
  return {
    leading: events.slice(0, anchorIdx + 1),
    trailing: events.slice(anchorIdx + 1),
  };
}
