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
  type OosReturnPoint,
  type StrategyDiversificationAssessment,
  assessStrategyDiversification,
} from "./strategy-diversification";
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
  /** A signed deployment authorization, not a measured live-performance result. */
  manualLiveDeploymentApproved: boolean;
  /** @deprecated Use manualLiveDeploymentApproved; retained for API compatibility. */
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
  /** Cohorts with matching backtest + walk-forward + paper evidence. */
  comparisonCohortIds: string[];
  comparisonCohortId: string | null;
}

export type ManualLiveDeploymentAdmission = {
  version: "strategy-live-admission-v1";
  kind: "manual_champion_bootstrap" | "challenger_replacement";
  decision: "manual_champion_bootstrap_required" | "candidate_for_manual_promotion";
  comparisonCohortId: string;
  championStrategyVersionId: string | null;
  challengerStrategyVersionId: string;
  diversification: StrategyDiversificationAssessment | null;
};

type PromotionComparisonForAdmission = {
  comparisonCohortId: string | null;
  champion: Pick<StrategyVersionScorecard, "strategyVersionId"> | null;
  challenger: Pick<StrategyVersionScorecard, "strategyVersionId"> | null;
  diversification: StrategyDiversificationAssessment;
  promotionEligible: boolean;
  decision: string;
};

/**
 * Converts a read-only champion/challenger result into the narrow evidence a
 * human may sign for limited live deployment. The first admitted strategy is
 * explicitly labelled as a bootstrap; every subsequent challenger must have
 * passed the paired frozen-OOS diversification gate.
 */
export function resolveManualLiveDeploymentAdmission(
  comparison: PromotionComparisonForAdmission
): ManualLiveDeploymentAdmission | null {
  const comparisonCohortId = comparison.comparisonCohortId?.trim();
  const challengerStrategyVersionId = comparison.challenger?.strategyVersionId?.trim();
  if (!comparisonCohortId || !challengerStrategyVersionId) return null;
  if (comparison.decision === "manual_champion_bootstrap_required" && !comparison.champion) {
    return {
      version: "strategy-live-admission-v1",
      kind: "manual_champion_bootstrap",
      decision: "manual_champion_bootstrap_required",
      comparisonCohortId,
      championStrategyVersionId: null,
      challengerStrategyVersionId,
      diversification: null,
    };
  }
  if (
    comparison.decision === "candidate_for_manual_promotion" &&
    comparison.promotionEligible &&
    comparison.champion?.strategyVersionId &&
    comparison.diversification.pass
  ) {
    return {
      version: "strategy-live-admission-v1",
      kind: "challenger_replacement",
      decision: "candidate_for_manual_promotion",
      comparisonCohortId,
      championStrategyVersionId: comparison.champion.strategyVersionId,
      challengerStrategyVersionId,
      diversification: comparison.diversification,
    };
  }
  return null;
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
      /** Fixed OOS comparison cohort; if omitted only an unambiguous cohort is selected. */
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
    const diversification = assessStrategyDiversification({
      champion: champion
        ? readWalkForwardOosReturns(rows, champion.strategyVersionId, comparisonCohortId)
        : [],
      challenger: challenger
        ? readWalkForwardOosReturns(rows, challenger.strategyVersionId, comparisonCohortId)
        : [],
    });
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
            : !diversification.pass
              ? "challenger_diversification_evidence_missing_or_failed"
              : scoreUplift != null && scoreUplift >= minimumScoreUplift
                ? "candidate_for_manual_promotion"
                : "keep_champion";
    if (overviewChallenger) {
      const reviewDecision =
        decision === "candidate_for_manual_promotion"
          ? "eligible"
          : diversification.status === "correlation_too_high" ||
              diversification.status === "no_incremental_risk_adjusted_value"
            ? "rejected"
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
            diversification,
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
      diversification,
      promotionEligible: Boolean(
        !cohortUnavailable &&
          champion &&
          challenger &&
          challenger.allPrerequisitesPassed &&
          diversification.pass &&
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
    const passedOnCohort = (kind: "walk_forward" | "paper") =>
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
    const manualLiveDeploymentApproved = Boolean(
      comparisonCohortId &&
        rows.some(
          (row) =>
            row.pass === true &&
            isManualLiveDeploymentApproval(row) &&
            readStrategyComparisonCohortId(row.metricsJson) === comparisonCohortId
        )
    );
    const integrity = assessQuantResearchIntegrity({
      stage: "live",
      evidence: {
        validationQualifiedDataset,
        backtestIntegrity: backtestIntegrityPassed && backtest?.pass === true,
        factorRiskExposure: factorRiskExposurePassed,
        walkForward: walkForwardPassed,
        finalHoldout: finalHoldoutPassed,
        paper: paperPassed,
        humanApproval: manualLiveDeploymentApproved,
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
      manualLiveDeploymentApproved,
      manuallyApproved: manualLiveDeploymentApproved,
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
    const comparison = await this.compareVersions(
      {
        projectId: resolved.projectId,
        challengerStrategyVersionId: resolved.strategyVersionId,
        comparisonCohortId: assessment.comparisonCohortId,
      },
      db
    );
    const admission = resolveManualLiveDeploymentAdmission(comparison);
    if (!admission) {
      throw new Error(`promotion_candidate_gate_blocked:${comparison.decision}`);
    }
    const liveRows = await db
      .select({
        id: strategyEvalRun.id,
        scenarioKey: strategyEvalRun.scenarioKey,
        evalKind: strategyEvalRun.evalKind,
        metricsJson: strategyEvalRun.metricsJson,
      })
      .from(strategyEvalRun)
      .where(
        and(
          eq(strategyEvalRun.strategyVersionId, resolved.strategyVersionId),
          eq(strategyEvalRun.evalKind, "live")
        )
      );
    // `eval_kind='live'` is also the legacy bucket for measured live results.
    // Never overwrite one of those with an approval and never let one stand in
    // for a human decision.
    const existing = liveRows.find(isManualLiveDeploymentApproval);
    const id = existing?.id ?? randomUUID();
    const values = {
      metricsJson: {
        strategyRuntimeId,
        reviewer: reviewer.trim() || "user",
        approvedAt: new Date().toISOString(),
        approvalKind: "manual_limited_live_deployment_v2",
        gateVersion: "live-approval-v2",
        comparisonCohort: { id: assessment.comparisonCohortId },
        promotionAdmission: admission,
      },
      qualityScore: 1,
      pass: true,
      notes: `limited_live_deployment_approved_by:${reviewer.trim() || "user"}`,
      createdBy: reviewer.trim() || "user",
    };
    if (existing) {
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
    await this.assertStrategyVersionLiveEligible(resolved.strategyVersionId, db);
  }

  /**
   * Central real-money gate for every entry point that has a strategy version
   * but not necessarily a strategy-runtime record (manual intent, rebalance,
   * recovery worker). It intentionally checks more than a base backtest.
   */
  async assertStrategyVersionLiveEligible(
    strategyVersionId: string,
    client?: DbClient
  ): Promise<void> {
    const db = client ?? (await getDb());
    const assessment = await this.assess(strategyVersionId, db);
    if (!assessment.liveEligible) {
      throw new Error(`live_promotion_gate_blocked:${JSON.stringify(assessment)}`);
    }
    const datasetAdmission = await assessStrategyExecutionAdmission(db, strategyVersionId);
    if (!datasetAdmission.eligible) {
      throw new Error(`live_dataset_admission_blocked:${JSON.stringify(datasetAdmission)}`);
    }
  }
}

function readWalkForwardOosReturns(
  rows: Array<typeof strategyEvalRun.$inferSelect>,
  strategyVersionId: string,
  comparisonCohortId: string | undefined
): OosReturnPoint[] {
  const evaluation = rows
    .filter(
      (row) =>
        row.strategyVersionId === strategyVersionId &&
        row.evalKind === "walk_forward" &&
        row.pass === true &&
        (!comparisonCohortId ||
          readStrategyComparisonCohortId(row.metricsJson) === comparisonCohortId)
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const value = evaluation?.metricsJson;
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const series = (value as Record<string, unknown>).oosReturnSeries;
  if (!Array.isArray(series)) return [];
  return series.flatMap((point) => {
    if (!point || typeof point !== "object" || Array.isArray(point)) return [];
    const item = point as Record<string, unknown>;
    const timestamp = typeof item.timestamp === "string" ? item.timestamp.trim() : "";
    const value = Number(item.return);
    return timestamp && Number.isFinite(value) ? [{ timestamp, return: value }] : [];
  });
}

/**
 * Isolate authorization from actual live performance. A valid approval also
 * proves that it was either an explicit first-champion bootstrap or a current
 * challenger with paired frozen-OOS diversification evidence. Arbitrary
 * eval_kind='live' observations and legacy label-only approvals are excluded.
 */
export function isManualLiveDeploymentApproval(
  row: Pick<typeof strategyEvalRun.$inferSelect, "evalKind" | "scenarioKey" | "metricsJson">
): boolean {
  if (row.evalKind !== "live" || row.scenarioKey !== "live_approval") return false;
  const metrics = row.metricsJson;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return false;
  const value = metrics as Record<string, unknown>;
  return (
    value.approvalKind === "manual_limited_live_deployment_v2" &&
    value.gateVersion === "live-approval-v2" &&
    isManualLiveDeploymentAdmission(value.promotionAdmission)
  );
}

function isManualLiveDeploymentAdmission(value: unknown): value is ManualLiveDeploymentAdmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const admission = value as Record<string, unknown>;
  const cohort =
    typeof admission.comparisonCohortId === "string" ? admission.comparisonCohortId : "";
  const challenger =
    typeof admission.challengerStrategyVersionId === "string"
      ? admission.challengerStrategyVersionId
      : "";
  if (admission.version !== "strategy-live-admission-v1" || !cohort.trim() || !challenger.trim()) {
    return false;
  }
  if (
    admission.kind === "manual_champion_bootstrap" &&
    admission.decision === "manual_champion_bootstrap_required" &&
    admission.championStrategyVersionId === null &&
    admission.diversification === null
  ) {
    return true;
  }
  if (
    admission.kind === "challenger_replacement" &&
    admission.decision === "candidate_for_manual_promotion" &&
    typeof admission.championStrategyVersionId === "string" &&
    Boolean(
      admission.diversification &&
        typeof admission.diversification === "object" &&
        !Array.isArray(admission.diversification) &&
        (admission.diversification as Record<string, unknown>).pass === true
    )
  ) {
    return true;
  }
  return false;
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
