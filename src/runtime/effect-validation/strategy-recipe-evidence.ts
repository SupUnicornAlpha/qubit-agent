import { and, desc, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import { backtestRun, strategyEvalRun } from "../../db/sqlite/schema";
import { matchesFinalHoldoutEvidence } from "../backtest/final-holdout-contract";
import type { StrategyRecipeValidationEvidence } from "../context/finance-memory-schemas";
import { hasValidatedStrategyRecipeEvidence as hasValidatedEvidenceSchema } from "../context/finance-memory-schemas";
import { readStrategyComparisonCohortId } from "./strategy-comparison-cohort";
import {
  hasPassedBacktestIntegrity,
  hasValidationQualifiedDataset,
} from "./strategy-evaluation-service";
import { hasPassedFactorRiskExposure } from "./strategy-promotion-service";

/** Host-stamped proof that a reusable strategy recipe came from validated evidence. */
export type StrategyRecipeEvidence = StrategyRecipeValidationEvidence;

export type StrategyRecipeEvidenceAssessment =
  | { eligible: true; evidence: StrategyRecipeEvidence; reasons: [] }
  | { eligible: false; evidence: null; reasons: string[] };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * A recipe is reusable only after the exact composition has a passed,
 * validation-qualified base backtest plus same-cohort walk-forward, one-shot
 * final Holdout and paper evidence. This is intentionally weaker than live
 * admission: activating the resulting Skill still requires human review.
 */
export async function assessStrategyRecipeEvidence(input: {
  projectId: string;
  compositionId: string;
  client?: DbClient;
}): Promise<StrategyRecipeEvidenceAssessment> {
  const db = input.client ?? (await getDb());
  const backtests = await db
    .select()
    .from(strategyEvalRun)
    .where(
      and(
        eq(strategyEvalRun.projectId, input.projectId),
        eq(strategyEvalRun.compositionId, input.compositionId),
        eq(strategyEvalRun.evalKind, "backtest")
      )
    )
    .orderBy(desc(strategyEvalRun.createdAt))
    .limit(20);

  for (const backtest of backtests) {
    const reasons: string[] = [];
    const metrics = asRecord(backtest.metricsJson);
    const datasetSnapshotId =
      typeof metrics.datasetSnapshotId === "string" ? metrics.datasetSnapshotId : null;
    const comparisonCohortId = readStrategyComparisonCohortId(metrics);
    if (!backtest.strategyVersionId) reasons.push("strategy_version_missing");
    if (!backtest.backtestRunId) reasons.push("backtest_run_missing");
    if (!datasetSnapshotId) reasons.push("dataset_snapshot_missing");
    if (!comparisonCohortId) reasons.push("comparison_cohort_missing");
    if (backtest.pass !== true) reasons.push("backtest_not_passed");
    if (!hasValidationQualifiedDataset(metrics)) reasons.push("dataset_not_validation_qualified");
    if (!hasPassedBacktestIntegrity(metrics)) reasons.push("backtest_integrity_not_passed");
    if (!hasPassedFactorRiskExposure(metrics)) reasons.push("factor_risk_exposure_not_passed");
    if (
      reasons.length > 0 ||
      !backtest.strategyVersionId ||
      !backtest.backtestRunId ||
      !datasetSnapshotId ||
      !comparisonCohortId
    ) {
      continue;
    }
    const strategyVersionId = backtest.strategyVersionId;
    const backtestRunId = backtest.backtestRunId;
    const source = (
      await db
        .select({
          strategyVersionId: backtestRun.strategyVersionId,
          compositionId: backtestRun.compositionId,
          datasetSnapshotId: backtestRun.datasetSnapshotId,
        })
        .from(backtestRun)
        .where(eq(backtestRun.id, backtestRunId))
        .limit(1)
    )[0];
    if (!source) reasons.push("backtest_source_missing");
    if (source?.strategyVersionId !== strategyVersionId) {
      reasons.push("backtest_strategy_version_mismatch");
    }
    if (source?.compositionId !== input.compositionId) {
      reasons.push("backtest_composition_mismatch");
    }
    if (source?.datasetSnapshotId !== datasetSnapshotId) {
      reasons.push("backtest_dataset_snapshot_mismatch");
    }
    if (reasons.length > 0) continue;

    const rows = await db
      .select()
      .from(strategyEvalRun)
      .where(eq(strategyEvalRun.strategyVersionId, strategyVersionId))
      .orderBy(desc(strategyEvalRun.createdAt))
      .limit(80);
    const sameCohortPassed = (kind: "walk_forward" | "paper") =>
      rows.some(
        (row) =>
          row.evalKind === kind &&
          row.pass === true &&
          row.compositionId === input.compositionId &&
          readStrategyComparisonCohortId(row.metricsJson) === comparisonCohortId
      );
    if (!sameCohortPassed("walk_forward")) reasons.push("walk_forward_missing_on_cohort");
    if (!sameCohortPassed("paper")) reasons.push("paper_missing_on_cohort");
    const holdout = rows.find(
      (row) =>
        row.evalKind === "holdout" &&
        row.pass === true &&
        row.compositionId === input.compositionId &&
        row.backtestRunId === backtestRunId &&
        matchesFinalHoldoutEvidence(row.metricsJson, {
          strategyVersionId,
          datasetSnapshotId,
        })
    );
    const holdoutContract = asRecord(holdout?.metricsJson).contract;
    const finalHoldoutFingerprint = asRecord(holdoutContract).fingerprint;
    if (typeof finalHoldoutFingerprint !== "string") reasons.push("final_holdout_missing");
    if (reasons.length > 0 || typeof finalHoldoutFingerprint !== "string") continue;
    return {
      eligible: true,
      evidence: {
        status: "validated",
        strategyVersionId,
        compositionId: input.compositionId,
        backtestRunId,
        datasetSnapshotId,
        comparisonCohortId,
        finalHoldoutFingerprint,
        verifiedAt: new Date().toISOString(),
      },
      reasons: [],
    };
  }
  return {
    eligible: false,
    evidence: null,
    reasons:
      backtests.length === 0
        ? ["strategy_recipe_backtest_missing"]
        : ["strategy_recipe_evidence_incomplete"],
  };
}

export function hasValidatedStrategyRecipeEvidence(
  value: unknown
): value is StrategyRecipeEvidence {
  return hasValidatedEvidenceSchema(value);
}
