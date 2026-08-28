import type { RunScorecard } from "../benchmark/contracts";
import { booleanScore, categoricalScore, numericScore } from "../score-value";
import type { ScoreContributor, ScoreContributorContext, ScoreDraft } from "./contracts";

/** 将 Benchmark Scorecard 映射为统一 Score；不修改 scorecard 模块。 */
export function scorecardToDrafts(scorecard: RunScorecard): ScoreDraft[] {
  const drafts: ScoreDraft[] = [
    {
      name: "benchmark.overall.score",
      ...numericScore(scorecard.score),
      source: "code",
      evaluatorId: "benchmark.scorecard",
    },
    {
      name: "benchmark.overall.pass",
      ...booleanScore(scorecard.pass),
      source: "code",
      evaluatorId: "benchmark.scorecard",
    },
    {
      name: "benchmark.promotion_eligible",
      ...booleanScore(scorecard.promotionEligible),
      source: "code",
      evaluatorId: "benchmark.scorecard",
    },
    {
      name: "benchmark.hard.pass",
      ...booleanScore(scorecard.layers.hard.pass),
      source: "code",
      evaluatorId: "benchmark.scorecard",
    },
    {
      name: "benchmark.hard.complete",
      ...booleanScore(scorecard.layers.hard.complete),
      source: "code",
      evaluatorId: "benchmark.scorecard",
    },
  ];

  if (scorecard.layers.trajectory.score !== null) {
    drafts.push({
      name: "benchmark.trajectory.score",
      ...numericScore(scorecard.layers.trajectory.score),
      source: "code",
      evaluatorId: "benchmark.scorecard",
    });
  }
  drafts.push({
    name: "benchmark.trajectory.pass",
    ...booleanScore(scorecard.layers.trajectory.pass),
    source: "code",
    evaluatorId: "benchmark.scorecard",
  });

  if (scorecard.layers.soft.score !== null) {
    drafts.push({
      name: "benchmark.soft.score",
      ...numericScore(scorecard.layers.soft.score),
      source: "code",
      evaluatorId: "benchmark.scorecard",
    });
  }
  drafts.push({
    name: "benchmark.soft.status",
    ...categoricalScore(scorecard.layers.soft.status),
    source: "code",
    evaluatorId: "benchmark.scorecard",
  });

  for (const dim of scorecard.layers.soft.dimensions) {
    if (dim.score !== null) {
      drafts.push({
        name: `benchmark.soft.${dim.id}`,
        ...numericScore(dim.score, dim.detail),
        source: "code",
        evaluatorId: "benchmark.scorecard",
      });
    }
    drafts.push({
      name: `benchmark.soft.${dim.id}.status`,
      ...categoricalScore(dim.status, dim.detail),
      source: "code",
      evaluatorId: "benchmark.scorecard",
    });
  }

  for (const assertion of scorecard.layers.hard.assertions) {
    drafts.push({
      name: `hard.${assertion.id}`,
      ...categoricalScore(assertion.status, assertion.detail),
      source: "code",
      evaluatorId: "benchmark.hard",
    });
    drafts.push({
      name: `hard.${assertion.id}.pass`,
      ...booleanScore(assertion.status === "pass", assertion.detail),
      source: "code",
      evaluatorId: "benchmark.hard",
    });
  }

  if (scorecard.layers.outcome.score !== null) {
    drafts.push({
      name: "benchmark.outcome.score",
      ...numericScore(scorecard.layers.outcome.score),
      source: "code",
      evaluatorId: "benchmark.scorecard",
    });
  }
  drafts.push({
    name: "benchmark.outcome.status",
    ...categoricalScore(scorecard.layers.outcome.status),
    source: "code",
    evaluatorId: "benchmark.scorecard",
  });

  return drafts;
}

export function createBenchmarkScoreContributor(deps: {
  buildScorecard: (workflowRunId: string) => Promise<RunScorecard | null>;
}): ScoreContributor {
  return {
    id: "benchmark.scorecard",
    async contribute(ctx: ScoreContributorContext): Promise<ScoreDraft[]> {
      const scorecard = await deps.buildScorecard(ctx.workflowRunId);
      if (!scorecard) return [];
      return scorecardToDrafts(scorecard).map((draft) => ({
        ...draft,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.configFingerprint ? { configFingerprint: ctx.configFingerprint } : {}),
      }));
    },
  };
}
