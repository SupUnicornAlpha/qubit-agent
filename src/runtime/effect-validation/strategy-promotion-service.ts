import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import {
  indicatorStrategyScript,
  strategyEvalRun,
  strategyRuntime,
  workflowRun,
} from "../../db/sqlite/schema";
import { matchesFinalHoldoutEvidence } from "../backtest/final-holdout-contract";
import {
  type QuantResearchIntegrityAssessment,
  assessQuantResearchIntegrity,
} from "../harness/quant-research-integrity";
import { ensureStrategyVersionForScript } from "../strategy/strategy-version-resolver";
import { strategyCandidateReviewService } from "./strategy-candidate-review-service";
import { readStrategyComparisonCohortId } from "./strategy-comparison-cohort";
import {
  assessStrategyExecutionAdmission,
  hasPassedBacktestIntegrity,
  hasValidationQualifiedDataset,
} from "./strategy-evaluation-service";

export interface StrategyPromotionAssessment {
  strategyVersionId: string;
  comparisonCohortId: string | null;
  validationQualifiedDataset: boolean;
  backtestIntegrityPassed: boolean;
  backtestPassed: boolean;
  walkForwardPassed: boolean;
  finalHoldoutPassed: boolean;
  paperPassed: boolean;
  factorRiskExposurePassed: boolean;
  manuallyApproved: boolean;
  integrity: QuantResearchIntegrityAssessment;
  liveEligible: boolean;
}

export interface StrategyVersionScorecard {
  strategyVersionId: string;
  score: number;
  backtestScore: number | null;
  walkForwardScore: number | null;
  holdoutScore: number | null;
  paperScore: number | null;
  allPrerequisitesPassed: boolean;
  evaluationCount: number;
  /** Cohorts with matching backtest + walk-forward + shadow/paper evidence. */
  comparisonCohortIds: string[];
  comparisonCohortId: string | null;
}

export function buildStrategyVersionScorecards(
  rows: Array<typeof strategyEvalRun.$inferSelect>,
  comparisonCohortId?: string
): StrategyVersionScorecard[] {
  const byVersion = new Map<string, Array<typeof strategyEvalRun.$inferSelect>>();
  for (const row of rows) {
    if (!row.strategyVersionId) continue;
    const bucket = byVersion.get(row.strategyVersionId) ?? [];
    bucket.push(row);
    byVersion.set(row.strategyVersionId, bucket);
  }
  return [...byVersion]
    .map(([strategyVersionId, evaluations]) => {
      const latest = (kind: typeof strategyEvalRun.$inferSelect.evalKind) =>
        evaluations
          .filter(
            (row) =>
              row.evalKind === kind &&
              (!comparisonCohortId ||
                readStrategyComparisonCohortId(row.metricsJson) === comparisonCohortId)
          )
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const backtest = latest("backtest");
      const walkForward = latest("walk_forward");
      const holdout = evaluations
        .filter(
          (row) =>
            row.evalKind === "holdout" &&
            row.backtestRunId === backtest?.backtestRunId &&
            row.pass === true &&
            Boolean(
              backtest &&
                matchesFinalHoldoutEvidence(row.metricsJson, {
                  strategyVersionId: backtest.strategyVersionId,
                  datasetSnapshotId: readDatasetSnapshotId(backtest.metricsJson),
                })
            )
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const paper = latest("paper");
      const backtestScore = backtest?.qualityScore ?? null;
      const walkForwardScore = walkForward?.qualityScore ?? null;
      const holdoutScore = holdout?.qualityScore ?? null;
      const paperScore = paper?.qualityScore ?? null;
      const allPrerequisitesPassed =
        backtest?.pass === true &&
        hasValidationQualifiedDataset(backtest.metricsJson) &&
        hasPassedBacktestIntegrity(backtest.metricsJson) &&
        hasPassedFactorRiskExposure(backtest.metricsJson) &&
        walkForward?.pass === true &&
        holdout?.pass === true &&
        paper?.pass === true;
      const score =
        (backtestScore ?? 0) * 0.2 +
        (walkForwardScore ?? 0) * 0.3 +
        (holdoutScore ?? 0) * 0.2 +
        (paperScore ?? 0) * 0.3;
      const comparisonCohortIds = intersectCohorts(evaluations);
      return {
        strategyVersionId,
        score: Number(score.toFixed(6)),
        backtestScore,
        walkForwardScore,
        holdoutScore,
        paperScore,
        allPrerequisitesPassed,
        evaluationCount: evaluations.length,
        comparisonCohortIds,
        comparisonCohortId: comparisonCohortId ?? null,
      };
    })
    .sort((left, right) => right.score - left.score);
}

export class StrategyPromotionService {
  async compareVersions(
    input: {
      projectId: string;
      challengerStrategyVersionId?: string;
      minimumScoreUplift?: number;
      /** Fixed OOS/shadow cohort; if omitted only an unambiguous cohort is selected. */
      comparisonCohortId?: string;
    },
    client?: DbClient
  ) {
    const db = client ?? (await getDb());
    const rows = await db
      .select()
      .from(strategyEvalRun)
      .where(eq(strategyEvalRun.projectId, input.projectId));
    const overviewScorecards = buildStrategyVersionScorecards(rows);
    const overviewChallenger = input.challengerStrategyVersionId
      ? (overviewScorecards.find(
          (row) => row.strategyVersionId === input.challengerStrategyVersionId
        ) ?? null)
      : (overviewScorecards[0] ?? null);
    const requestedCohort = input.comparisonCohortId?.trim();
    const candidateCohorts = overviewChallenger?.comparisonCohortIds ?? [];
    const comparisonCohortId =
      requestedCohort || (candidateCohorts.length === 1 ? candidateCohorts[0] : undefined);
    const scorecards = comparisonCohortId
      ? buildStrategyVersionScorecards(rows, comparisonCohortId)
      : overviewScorecards;
    const challenger = overviewChallenger
      ? (scorecards.find((row) => row.strategyVersionId === overviewChallenger.strategyVersionId) ??
        null)
      : null;
    const champion =
      scorecards.find(
        (row) =>
          row.strategyVersionId !== challenger?.strategyVersionId && row.allPrerequisitesPassed
      ) ?? null;
    const minimumScoreUplift = Math.max(0, input.minimumScoreUplift ?? 0.03);
    const scoreUplift = challenger && champion ? challenger.score - champion.score : null;
    const cohortUnavailable =
      !overviewChallenger ||
      !comparisonCohortId ||
      !overviewChallenger.comparisonCohortIds.includes(comparisonCohortId);
    const decision = !overviewChallenger
      ? "no_challenger"
      : cohortUnavailable
        ? requestedCohort
          ? "challenger_not_evaluated_on_comparison_cohort"
          : candidateCohorts.length > 1
            ? "comparison_cohort_required"
            : "challenger_comparison_cohort_missing"
        : !challenger || !challenger.allPrerequisitesPassed
          ? "challenger_missing_backtest_walkforward_or_paper"
          : !champion
            ? "manual_champion_bootstrap_required"
            : scoreUplift != null && scoreUplift >= minimumScoreUplift
              ? "candidate_for_manual_promotion"
              : "keep_champion";
    if (overviewChallenger) {
      const reviewDecision =
        decision === "candidate_for_manual_promotion"
          ? "eligible"
          : decision === "keep_champion"
            ? "rejected"
            : "incomplete";
      await strategyCandidateReviewService.record(
        {
          projectId: input.projectId,
          strategyVersionId: overviewChallenger.strategyVersionId,
          comparisonCohortId:
            comparisonCohortId ?? `review_challenger:${overviewChallenger.strategyVersionId}`,
          decision: reviewDecision,
          reasonCodes: reviewDecision === "eligible" ? [] : [decision],
          correlationEvidence: {
            championStrategyVersionId: champion?.strategyVersionId ?? null,
            scoreUplift,
            minimumScoreUplift,
          },
          createdBy: "strategy_champion_challenger",
        },
        db
      );
    }
    return {
      projectId: input.projectId,
      comparisonCohortId: comparisonCohortId ?? null,
      champion,
      challenger,
      scoreUplift,
      minimumScoreUplift,
      promotionEligible: Boolean(
        !cohortUnavailable &&
          champion &&
          challenger &&
          challenger.allPrerequisitesPassed &&
          scoreUplift != null &&
          scoreUplift >= minimumScoreUplift
      ),
      decision,
      autoPromoted: false,
      scorecards,
      overviewScorecards,
    };
  }

  async assess(strategyVersionId: string, client?: DbClient): Promise<StrategyPromotionAssessment> {
    const db = client ?? (await getDb());
    const rows = await db
      .select()
      .from(strategyEvalRun)
      .where(eq(strategyEvalRun.strategyVersionId, strategyVersionId));
    const backtest = rows
      .filter((row) => row.evalKind === "backtest")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    const validationQualifiedDataset = hasValidationQualifiedDataset(backtest?.metricsJson);
    const backtestIntegrityPassed = hasPassedBacktestIntegrity(backtest?.metricsJson);
    const backtestPassed =
      backtest?.pass === true && validationQualifiedDataset && backtestIntegrityPassed;
    const factorRiskExposurePassed = hasPassedFactorRiskExposure(backtest?.metricsJson);
    const comparisonCohortId = readStrategyComparisonCohortId(backtest?.metricsJson);
    const passedOnCohort = (kind: "walk_forward" | "paper" | "live") =>
      Boolean(
        comparisonCohortId &&
          rows.some(
            (row) =>
              row.evalKind === kind &&
              row.pass === true &&
              readStrategyComparisonCohortId(row.metricsJson) === comparisonCohortId
          )
      );
    const walkForwardPassed = passedOnCohort("walk_forward");
    const finalHoldoutPassed = hasPassedFinalHoldout(backtest, rows);
    const paperPassed = passedOnCohort("paper");
    const manuallyApproved = passedOnCohort("live");
    const integrity = assessQuantResearchIntegrity({
      stage: "live",
      evidence: {
        validationQualifiedDataset,
        backtestIntegrity: backtestIntegrityPassed && backtest?.pass === true,
        factorRiskExposure: factorRiskExposurePassed,
        walkForward: walkForwardPassed,
        finalHoldout: finalHoldoutPassed,
        paper: paperPassed,
        humanApproval: manuallyApproved,
      },
    });
    return {
      strategyVersionId,
      comparisonCohortId,
      validationQualifiedDataset,
      backtestIntegrityPassed,
      backtestPassed,
      walkForwardPassed,
      finalHoldoutPassed,
      paperPassed,
      factorRiskExposurePassed,
      manuallyApproved,
      integrity,
      liveEligible: integrity.passed,
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
    // An approval is a live-governance action, not a paper result. Require the
    // full evidence chain before writing it so an old approval cannot become
    // valid merely because somebody later runs the reserved holdout window.
    const promotionEvidence = assessQuantResearchIntegrity({
      stage: "live",
      evidence: {
        validationQualifiedDataset: assessment.validationQualifiedDataset,
        backtestIntegrity: assessment.backtestIntegrityPassed,
        factorRiskExposure: assessment.factorRiskExposurePassed,
        walkForward: assessment.walkForwardPassed,
        finalHoldout: assessment.finalHoldoutPassed,
        paper: assessment.paperPassed,
        // This call is about to create the human approval record. The other
        // live evidence must already be present; the approval itself cannot
        // be used to satisfy a missing prerequisite.
        humanApproval: true,
      },
    });
    if (!promotionEvidence.passed) {
      throw new Error(
        `promotion_prerequisites_not_passed:${promotionEvidence.missingChecks.join(",")}`
      );
    }
    if (!assessment.comparisonCohortId) throw new Error("promotion_comparison_cohort_missing");
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
        comparisonCohort: { id: assessment.comparisonCohortId },
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
    const datasetAdmission = await assessStrategyExecutionAdmission(db, resolved.strategyVersionId);
    if (!datasetAdmission.eligible) {
      throw new Error(`live_dataset_admission_blocked:${JSON.stringify(datasetAdmission)}`);
    }
  }
}

export function hasPassedFactorRiskExposure(metrics: unknown): boolean {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return false;
  const evidence = (metrics as Record<string, unknown>).factorRiskExposure;
  // Legacy/non-factor evaluations have no factor exposure requirement. Fresh
  // factor compositions always persist an explicit `required` field.
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return true;
  const row = evidence as Record<string, unknown>;
  return row.required !== true || row.status === "passed";
}

function hasPassedFinalHoldout(
  backtest: typeof strategyEvalRun.$inferSelect | undefined,
  rows: Array<typeof strategyEvalRun.$inferSelect>
): boolean {
  if (!backtest?.backtestRunId) return false;
  return rows.some(
    (row) =>
      row.evalKind === "holdout" &&
      row.backtestRunId === backtest.backtestRunId &&
      row.pass === true &&
      matchesFinalHoldoutEvidence(row.metricsJson, {
        strategyVersionId: backtest.strategyVersionId,
        datasetSnapshotId: readDatasetSnapshotId(backtest.metricsJson),
      })
  );
}

function readDatasetSnapshotId(metricsJson: unknown): string | null {
  if (!metricsJson || typeof metricsJson !== "object" || Array.isArray(metricsJson)) return null;
  const snapshotId = (metricsJson as Record<string, unknown>).datasetSnapshotId;
  return typeof snapshotId === "string" ? snapshotId : null;
}

function intersectCohorts(rows: Array<typeof strategyEvalRun.$inferSelect>): string[] {
  const cohortsFor = (kind: typeof strategyEvalRun.$inferSelect.evalKind) =>
    new Set(
      rows
        .filter((row) => row.evalKind === kind)
        .map((row) => readStrategyComparisonCohortId(row.metricsJson))
        .filter((value): value is string => Boolean(value))
    );
  const backtest = cohortsFor("backtest");
  const walkForward = cohortsFor("walk_forward");
  const paper = cohortsFor("paper");
  return [...backtest].filter((cohort) => walkForward.has(cohort) && paper.has(cohort)).sort();
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
