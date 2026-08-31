import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import { componentEvalRun } from "../../db/sqlite/schema";

export type GovernedComponentKind =
  | "agent"
  | "prompt"
  | "tool"
  | "model"
  | "skill"
  | "data_source"
  | "harness";

export type ComponentScorecard = {
  versionId: string;
  comparisonCohortId: string;
  score: number;
  sampleSize: number;
  evaluationCount: number;
  eligible: boolean;
  evalKinds: Array<"offline" | "shadow" | "paper">;
};

export function resolveShadowVariant(input: {
  allocationKey: string;
  challengerTrafficPct: number;
  executionMode?: "research" | "backtest" | "paper" | "live";
}): "control" | "challenger" {
  if (input.executionMode === "live") return "control";
  const allocation = Math.max(0, Math.min(0.2, input.challengerTrafficPct));
  const bucket =
    Number.parseInt(
      createHash("sha256").update(input.allocationKey).digest("hex").slice(0, 8),
      16
    ) / 0xffffffff;
  return bucket < allocation ? "challenger" : "control";
}

export function buildComponentScorecards(
  rows: Array<typeof componentEvalRun.$inferSelect>,
  minimumSamples = 20
): ComponentScorecard[] {
  const versions = new Map<
    string,
    {
      versionId: string;
      comparisonCohortId: string;
      rows: Array<typeof componentEvalRun.$inferSelect>;
    }
  >();
  for (const row of rows) {
    // Old evaluation rows without a frozen benchmark cohort remain observable
    // in storage but are intentionally ineligible for promotion.
    const comparisonCohortId = row.comparisonCohortId?.trim();
    if (!comparisonCohortId) continue;
    const key = `${row.versionId}\u0000${comparisonCohortId}`;
    const bucket = versions.get(key) ?? {
      versionId: row.versionId,
      comparisonCohortId,
      rows: [],
    };
    bucket.rows.push(row);
    versions.set(key, bucket);
  }
  return [...versions.values()]
    .map(({ versionId, comparisonCohortId, rows: evaluations }) => {
      const sampleSize = evaluations.reduce((sum, row) => sum + row.sampleSize, 0);
      const weightedScore =
        sampleSize > 0
          ? evaluations.reduce((sum, row) => sum + row.qualityScore * row.sampleSize, 0) /
            sampleSize
          : 0;
      const evalKinds = [...new Set(evaluations.map((row) => row.evalKind))];
      return {
        versionId,
        comparisonCohortId,
        score: Number(weightedScore.toFixed(6)),
        sampleSize,
        evaluationCount: evaluations.length,
        eligible:
          sampleSize >= minimumSamples &&
          evaluations.every((row) => row.pass) &&
          evalKinds.includes("offline") &&
          (evalKinds.includes("shadow") || evalKinds.includes("paper")),
        evalKinds,
      };
    })
    .sort((left, right) => right.score - left.score);
}

export class ComponentChallengerService {
  async record(
    input: {
      projectId: string;
      workflowRunId?: string;
      componentKind: GovernedComponentKind;
      componentId: string;
      versionId: string;
      comparisonCohortId: string;
      evalKind: "offline" | "shadow" | "paper";
      sampleSize: number;
      metrics: Record<string, unknown>;
      qualityScore: number;
      pass: boolean;
      createdBy?: string;
    },
    client?: DbClient
  ) {
    const db = client ?? (await getDb());
    const comparisonCohortId = input.comparisonCohortId.trim();
    if (!comparisonCohortId) throw new Error("component_comparison_cohort_required");
    const id = randomUUID();
    await db.insert(componentEvalRun).values({
      id,
      projectId: input.projectId,
      workflowRunId: input.workflowRunId ?? null,
      componentKind: input.componentKind,
      componentId: input.componentId,
      versionId: input.versionId,
      comparisonCohortId,
      evalKind: input.evalKind,
      sampleSize: Math.max(0, Math.floor(input.sampleSize)),
      metricsJson: input.metrics,
      qualityScore: Math.max(0, Math.min(1, input.qualityScore)),
      pass: input.pass,
      createdBy: input.createdBy?.trim() || "system",
    });
    return { id };
  }

  async compare(
    input: {
      projectId: string;
      componentKind: GovernedComponentKind;
      componentId: string;
      challengerVersionId: string;
      comparisonCohortId: string;
      championVersionId?: string;
      minimumSamples?: number;
      minimumScoreUplift?: number;
    },
    client?: DbClient
  ) {
    const db = client ?? (await getDb());
    const comparisonCohortId = input.comparisonCohortId.trim();
    if (!comparisonCohortId) throw new Error("component_comparison_cohort_required");
    const rows = await db
      .select()
      .from(componentEvalRun)
      .where(
        and(
          eq(componentEvalRun.projectId, input.projectId),
          eq(componentEvalRun.componentKind, input.componentKind),
          eq(componentEvalRun.componentId, input.componentId),
          eq(componentEvalRun.comparisonCohortId, comparisonCohortId)
        )
      );
    const scorecards = buildComponentScorecards(rows, input.minimumSamples ?? 20);
    const challenger =
      scorecards.find((row) => row.versionId === input.challengerVersionId) ?? null;
    const champion = input.championVersionId
      ? (scorecards.find((row) => row.versionId === input.championVersionId) ?? null)
      : (scorecards.find((row) => row.versionId !== input.challengerVersionId && row.eligible) ??
        null);
    const minimumScoreUplift = Math.max(0, input.minimumScoreUplift ?? 0.03);
    const scoreUplift = challenger && champion ? challenger.score - champion.score : null;
    const promotionEligible = Boolean(
      challenger?.eligible && champion && scoreUplift != null && scoreUplift >= minimumScoreUplift
    );
    return {
      ...input,
      comparisonCohortId,
      champion,
      challenger,
      scoreUplift,
      minimumScoreUplift,
      promotionEligible,
      decision: !challenger
        ? "no_challenger"
        : !challenger.eligible
          ? "insufficient_or_failed_evidence"
          : !champion
            ? "manual_champion_bootstrap_required"
            : promotionEligible
              ? "candidate_for_manual_promotion"
              : "keep_champion",
      autoPromoted: false,
      scorecards,
    };
  }
}

export const componentChallengerService = new ComponentChallengerService();
