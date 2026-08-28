import { gradeSnapshot, type ReadinessSnapshot } from "../../agent-readiness/grader";
import { collectSnapshot } from "../../agent-readiness/snapshot-collector";
import { getScenarioRecipe, type ScenarioRecipe } from "../../agent-readiness/scenarios";
import type { ScoreContributor, ScoreContributorContext, ScoreDraft } from "../contracts";
import { categoricalScore, numericScore } from "../score-value";

function isScenarioKey(value: string | null): value is ScenarioRecipe["key"] {
  if (!value) return false;
  try {
    getScenarioRecipe(value as ScenarioRecipe["key"]);
    return true;
  } catch {
    return false;
  }
}

export function snapshotToDrafts(snapshot: ReadinessSnapshot, grade: ReturnType<typeof gradeSnapshot>): ScoreDraft[] {
  const drafts: ScoreDraft[] = [
    {
      name: "aqm.overall.grade",
      ...categoricalScore(grade.overall),
      source: "heuristic",
      evaluatorId: "aqm.grader",
    },
    {
      name: "aqm.weighted_score",
      ...numericScore(grade.weightedScore),
      source: "heuristic",
      evaluatorId: "aqm.grader",
    },
  ];

  for (const category of ["A", "B", "C", "D"] as const) {
    const value = grade.categoryScores[category];
    if (value !== null) {
      drafts.push({
        name: `aqm.category.${category}`,
        ...numericScore(value),
        source: "heuristic",
        evaluatorId: "aqm.grader",
      });
    }
  }

  for (const [metricId, value] of Object.entries(snapshot.metrics)) {
    if (value === null || value === undefined) continue;
    drafts.push({
      name: `aqm.${metricId}`,
      ...numericScore(value),
      source: "heuristic",
      evaluatorId: "aqm.snapshot",
    });
  }

  return drafts;
}

export function createAqmScoreContributor(): ScoreContributor {
  return {
    id: "aqm.snapshot",
    async contribute(ctx: ScoreContributorContext): Promise<ScoreDraft[]> {
      if (!isScenarioKey(ctx.scenarioKey)) return [];
      const snapshot = await collectSnapshot({
        workflowRunId: ctx.workflowRunId,
        scenario: ctx.scenarioKey,
      });
      const grade = gradeSnapshot(snapshot);
      return snapshotToDrafts(snapshot, grade).map((draft) => ({
        ...draft,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.configFingerprint ? { configFingerprint: ctx.configFingerprint } : {}),
      }));
    },
  };
}
