import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { recommendationOutcome, recommendationSnapshot } from "../../../db/sqlite/schema";
import type { ScoreContributor, ScoreContributorContext, ScoreDraft } from "../contracts";
import { booleanScore, categoricalScore, numericScore } from "../score-value";

export function outcomeRowsToDrafts(
  rows: Array<{
    recommendationId: string;
    symbol: string;
    horizonDays: number;
    returnPct: number | null;
    excessReturnPct: number | null;
    outcome: string;
    hit: boolean | null;
  }>
): ScoreDraft[] {
  const drafts: ScoreDraft[] = [];
  const evaluated = rows.filter((row) => row.outcome !== "pending" && row.outcome !== "invalid");

  for (const row of evaluated) {
    const prefix = `outcome.recommendation.${row.recommendationId}.h${row.horizonDays}`;
    if (row.returnPct !== null) {
      drafts.push({
        name: `${prefix}.return_pct`,
        ...numericScore(row.returnPct, row.symbol),
        source: "domain_plugin",
        evaluatorId: "quant.recommendation_outcome",
      });
    }
    if (row.excessReturnPct !== null) {
      drafts.push({
        name: `${prefix}.excess_return_pct`,
        ...numericScore(row.excessReturnPct, row.symbol),
        source: "domain_plugin",
        evaluatorId: "quant.recommendation_outcome",
      });
    }
    drafts.push({
      name: `${prefix}.label`,
      ...categoricalScore(row.outcome, row.symbol),
      source: "domain_plugin",
      evaluatorId: "quant.recommendation_outcome",
    });
    if (row.hit !== null) {
      drafts.push({
        name: `${prefix}.hit`,
        ...booleanScore(row.hit, row.symbol),
        source: "domain_plugin",
        evaluatorId: "quant.recommendation_outcome",
      });
    }
  }

  if (evaluated.length > 0) {
    const returns = evaluated
      .map((row) => row.returnPct)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const wins = evaluated.filter((row) => row.outcome === "win").length;
    drafts.push({
      name: "outcome.recommendation.evaluated_count",
      ...numericScore(evaluated.length),
      source: "domain_plugin",
      evaluatorId: "quant.recommendation_outcome",
    });
    drafts.push({
      name: "outcome.recommendation.win_rate",
      ...numericScore(wins / evaluated.length),
      source: "domain_plugin",
      evaluatorId: "quant.recommendation_outcome",
    });
    if (returns.length > 0) {
      drafts.push({
        name: "outcome.recommendation.avg_return_pct",
        ...numericScore(returns.reduce((sum, value) => sum + value, 0) / returns.length),
        source: "domain_plugin",
        evaluatorId: "quant.recommendation_outcome",
      });
    }
  }

  return drafts;
}

export function createOutcomeScoreContributor(): ScoreContributor {
  return {
    id: "quant.recommendation_outcome",
    async contribute(ctx: ScoreContributorContext): Promise<ScoreDraft[]> {
      const db = await getDb();
      const rows = await db
        .select({
          recommendationId: recommendationOutcome.recommendationId,
          symbol: recommendationSnapshot.symbol,
          horizonDays: recommendationOutcome.horizonDays,
          returnPct: recommendationOutcome.returnPct,
          excessReturnPct: recommendationOutcome.excessReturnPct,
          outcome: recommendationOutcome.outcome,
          hit: recommendationOutcome.hit,
        })
        .from(recommendationOutcome)
        .innerJoin(
          recommendationSnapshot,
          eq(recommendationOutcome.recommendationId, recommendationSnapshot.id)
        )
        .where(eq(recommendationSnapshot.workflowRunId, ctx.workflowRunId));

      return outcomeRowsToDrafts(rows).map((draft) => ({
        ...draft,
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...(ctx.configFingerprint ? { configFingerprint: ctx.configFingerprint } : {}),
      }));
    },
  };
}
