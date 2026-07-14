import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import {
  indicatorStrategyScript,
  strategyEvalRun,
  strategyRuntime,
  workflowRun,
} from "../../db/sqlite/schema";
import { ensureStrategyVersionForScript } from "../strategy/strategy-version-resolver";

export interface StrategyPromotionAssessment {
  strategyVersionId: string;
  backtestPassed: boolean;
  walkForwardPassed: boolean;
  paperPassed: boolean;
  manuallyApproved: boolean;
  liveEligible: boolean;
}

export interface StrategyVersionScorecard {
  strategyVersionId: string;
  score: number;
  backtestScore: number | null;
  walkForwardScore: number | null;
  paperScore: number | null;
  allPrerequisitesPassed: boolean;
  evaluationCount: number;
}

export function buildStrategyVersionScorecards(
  rows: Array<typeof strategyEvalRun.$inferSelect>,
): StrategyVersionScorecard[] {
  const byVersion = new Map<string, Array<typeof strategyEvalRun.$inferSelect>>();
  for (const row of rows) {
    if (!row.strategyVersionId) continue;
    const bucket = byVersion.get(row.strategyVersionId) ?? [];
    bucket.push(row);
    byVersion.set(row.strategyVersionId, bucket);
  }
  return [...byVersion].map(([strategyVersionId, evaluations]) => {
    const latest = (kind: typeof strategyEvalRun.$inferSelect.evalKind) =>
      evaluations
        .filter((row) => row.evalKind === kind)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const backtest = latest("backtest");
    const walkForward = latest("walk_forward");
    const paper = latest("paper");
    const backtestScore = backtest?.qualityScore ?? null;
    const walkForwardScore = walkForward?.qualityScore ?? null;
    const paperScore = paper?.qualityScore ?? null;
    const allPrerequisitesPassed = backtest?.pass === true && walkForward?.pass === true && paper?.pass === true;
    const score = (backtestScore ?? 0) * 0.25 + (walkForwardScore ?? 0) * 0.35 + (paperScore ?? 0) * 0.4;
    return {
      strategyVersionId,
      score: Number(score.toFixed(6)),
      backtestScore,
      walkForwardScore,
      paperScore,
      allPrerequisitesPassed,
      evaluationCount: evaluations.length,
    };
  }).sort((left, right) => right.score - left.score);
}

export class StrategyPromotionService {
  async compareVersions(input: {
    projectId: string;
    challengerStrategyVersionId?: string;
    minimumScoreUplift?: number;
  }, client?: DbClient) {
    const db = client ?? (await getDb());
    const rows = await db
      .select()
      .from(strategyEvalRun)
      .where(eq(strategyEvalRun.projectId, input.projectId));
    const scorecards = buildStrategyVersionScorecards(rows);
    const challenger = input.challengerStrategyVersionId
      ? scorecards.find((row) => row.strategyVersionId === input.challengerStrategyVersionId) ?? null
      : scorecards[0] ?? null;
    const champion = scorecards.find((row) =>
      row.strategyVersionId !== challenger?.strategyVersionId && row.allPrerequisitesPassed) ?? null;
    const minimumScoreUplift = Math.max(0, input.minimumScoreUplift ?? 0.03);
    const scoreUplift = challenger && champion ? challenger.score - champion.score : null;
    return {
      projectId: input.projectId,
      champion,
      challenger,
      scoreUplift,
      minimumScoreUplift,
      promotionEligible: Boolean(
        champion && challenger && challenger.allPrerequisitesPassed && scoreUplift != null && scoreUplift >= minimumScoreUplift
      ),
      decision: !challenger
        ? "no_challenger"
        : !challenger.allPrerequisitesPassed
          ? "challenger_missing_backtest_walkforward_or_paper"
          : !champion
            ? "manual_champion_bootstrap_required"
            : scoreUplift != null && scoreUplift >= minimumScoreUplift
              ? "candidate_for_manual_promotion"
              : "keep_champion",
      autoPromoted: false,
      scorecards,
    };
  }

  async assess(strategyVersionId: string, client?: DbClient): Promise<StrategyPromotionAssessment> {
    const db = client ?? (await getDb());
    const rows = await db
      .select()
      .from(strategyEvalRun)
      .where(eq(strategyEvalRun.strategyVersionId, strategyVersionId));
    const passed = (kind: typeof strategyEvalRun.$inferSelect.evalKind) =>
      rows.some((row) => row.evalKind === kind && row.pass === true);
    const backtestPassed = passed("backtest");
    const walkForwardPassed = passed("walk_forward");
    const paperPassed = passed("paper");
    const manuallyApproved = passed("live");
    return {
      strategyVersionId,
      backtestPassed,
      walkForwardPassed,
      paperPassed,
      manuallyApproved,
      liveEligible: backtestPassed && walkForwardPassed && paperPassed && manuallyApproved,
    };
  }

  async approveRuntime(
    strategyRuntimeId: string,
    reviewer: string,
    client?: DbClient
  ): Promise<StrategyPromotionAssessment> {
    const db = client ?? (await getDb());
    const resolved = await resolveRuntimeVersion(db, strategyRuntimeId);
    const assessment = await this.assess(resolved.strategyVersionId, db);
    if (!assessment.backtestPassed || !assessment.walkForwardPassed || !assessment.paperPassed) {
      throw new Error("promotion_prerequisites_not_passed");
    }
    const existing = await db
      .select({ id: strategyEvalRun.id })
      .from(strategyEvalRun)
      .where(
        and(
          eq(strategyEvalRun.strategyVersionId, resolved.strategyVersionId),
          eq(strategyEvalRun.evalKind, "live")
        )
      )
      .limit(1);
    const id = existing[0]?.id ?? randomUUID();
    const values = {
      metricsJson: {
        strategyRuntimeId,
        reviewer: reviewer.trim() || "user",
        approvedAt: new Date().toISOString(),
        gateVersion: "live-approval-v1",
      },
      qualityScore: 1,
      pass: true,
      notes: `live_approved_by:${reviewer.trim() || "user"}`,
      createdBy: reviewer.trim() || "user",
    };
    if (existing[0]) {
      await db.update(strategyEvalRun).set(values).where(eq(strategyEvalRun.id, id));
    } else {
      await db.insert(strategyEvalRun).values({
        id,
        workflowRunId: resolved.workflowRunId,
        projectId: resolved.projectId,
        strategyVersionId: resolved.strategyVersionId,
        scenarioKey: "live_approval",
        evalKind: "live",
        ...values,
      });
    }
    return this.assess(resolved.strategyVersionId, db);
  }

  async assertRuntimeLiveEligible(strategyRuntimeId: string, client?: DbClient): Promise<void> {
    const db = client ?? (await getDb());
    const resolved = await resolveRuntimeVersion(db, strategyRuntimeId);
    const assessment = await this.assess(resolved.strategyVersionId, db);
    if (!assessment.liveEligible) {
      throw new Error(`live_promotion_gate_blocked:${JSON.stringify(assessment)}`);
    }
  }
}

async function resolveRuntimeVersion(db: DbClient, strategyRuntimeId: string) {
  const runtimeRows = await db
    .select()
    .from(strategyRuntime)
    .where(eq(strategyRuntime.id, strategyRuntimeId))
    .limit(1);
  const runtime = runtimeRows[0];
  if (!runtime) throw new Error("strategy_runtime_not_found");
  const scriptRows = await db
    .select()
    .from(indicatorStrategyScript)
    .where(eq(indicatorStrategyScript.id, runtime.strategyScriptId))
    .limit(1);
  const script = scriptRows[0];
  if (!script) throw new Error("strategy_script_not_found");
  const version = await ensureStrategyVersionForScript(db, script);
  const workflowRows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, version.workflowRunId))
    .limit(1);
  const projectId = workflowRows[0]?.projectId;
  if (!projectId) throw new Error("workflow_project_not_found");
  return { ...version, projectId };
}

export const strategyPromotionService = new StrategyPromotionService();
