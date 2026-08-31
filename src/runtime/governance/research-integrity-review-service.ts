import { eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import { componentEvalRun, strategyEvalRun } from "../../db/sqlite/schema";
import { matchesFinalHoldoutEvidence } from "../backtest/final-holdout-contract";
import { readStrategyComparisonCohortId } from "../effect-validation/strategy-comparison-cohort";

type StrategyEvalRow = typeof strategyEvalRun.$inferSelect;
type ComponentEvalRow = typeof componentEvalRun.$inferSelect;

const STRATEGY_STAGES = ["backtest", "walk_forward", "holdout", "paper", "live"] as const;
type StrategyStage = (typeof STRATEGY_STAGES)[number];
type ReviewStage = { pass: boolean | null; id: string; createdAt: string };
type ReviewStages = Record<StrategyStage, ReviewStage | null>;

function latest(rows: readonly StrategyEvalRow[]): StrategyEvalRow | null {
  return [...rows].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

/** A passing evaluation remains useful evidence; otherwise expose the latest failure. */
function bestEvidence(rows: readonly StrategyEvalRow[]): ReviewStage | null {
  const row = latest(rows.filter((item) => item.pass === true)) ?? latest(rows);
  return row ? { pass: row.pass, id: row.id, createdAt: row.createdAt } : null;
}

function readDatasetSnapshotId(metrics: unknown): string | null {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return null;
  const snapshotId = (metrics as Record<string, unknown>).datasetSnapshotId;
  return typeof snapshotId === "string" ? snapshotId : null;
}

function buildUnboundStrategyReview(strategyVersionId: string, rows: StrategyEvalRow[]) {
  const stages = Object.fromEntries(
    STRATEGY_STAGES.map((stage) => [
      stage,
      bestEvidence(rows.filter((row) => row.evalKind === stage)),
    ])
  ) as ReviewStages;
  return {
    strategyVersionId,
    comparisonCohortId: null,
    stages,
    missingStages: STRATEGY_STAGES.filter((stage) => !stages[stage]),
    candidateForManualPromotion: false,
    promotionState: "evidence_incomplete" as const,
    readOnly: true as const,
  };
}

/**
 * Builds a view from one base backtest and its exact comparison cohort.
 * A UI review must never splice walk-forward / paper / live results from a
 * different frozen cohort into a superficially green strategy row.
 */
function buildCohortStrategyReview(input: {
  strategyVersionId: string;
  comparisonCohortId: string;
  baseBacktest: StrategyEvalRow;
  rows: StrategyEvalRow[];
}) {
  const { strategyVersionId, comparisonCohortId, baseBacktest, rows } = input;
  const onCohort = (stage: Exclude<StrategyStage, "backtest" | "holdout">) =>
    rows.filter(
      (row) =>
        row.evalKind === stage &&
        readStrategyComparisonCohortId(row.metricsJson) === comparisonCohortId
    );
  const datasetSnapshotId = readDatasetSnapshotId(baseBacktest.metricsJson);
  const holdouts = baseBacktest.backtestRunId
    ? rows.filter(
        (row) =>
          row.evalKind === "holdout" &&
          row.backtestRunId === baseBacktest.backtestRunId &&
          matchesFinalHoldoutEvidence(row.metricsJson, {
            strategyVersionId,
            datasetSnapshotId,
          })
      )
    : [];
  const stages: ReviewStages = {
    backtest: {
      pass: baseBacktest.pass,
      id: baseBacktest.id,
      createdAt: baseBacktest.createdAt,
    },
    walk_forward: bestEvidence(onCohort("walk_forward")),
    holdout: bestEvidence(holdouts),
    paper: bestEvidence(onCohort("paper")),
    live: bestEvidence(onCohort("live")),
  };
  const missingStages = STRATEGY_STAGES.filter((stage) => !stages[stage]);
  const candidateForManualPromotion =
    stages.backtest?.pass === true &&
    stages.walk_forward?.pass === true &&
    stages.holdout?.pass === true &&
    stages.paper?.pass === true;
  return {
    strategyVersionId,
    comparisonCohortId,
    stages,
    missingStages,
    candidateForManualPromotion,
    promotionState:
      stages.live?.pass === true
        ? ("live_approved" as const)
        : candidateForManualPromotion
          ? ("manual_review_required" as const)
          : ("evidence_incomplete" as const),
    readOnly: true as const,
  };
}

/** Pure, read-only projection for the human integrity review surface. */
export function buildResearchIntegrityReview(input: {
  strategies: StrategyEvalRow[];
  components: ComponentEvalRow[];
}) {
  const strategyBuckets = new Map<string, StrategyEvalRow[]>();
  for (const row of input.strategies) {
    if (!row.strategyVersionId) continue;
    const bucket = strategyBuckets.get(row.strategyVersionId) ?? [];
    bucket.push(row);
    strategyBuckets.set(row.strategyVersionId, bucket);
  }
  const strategies = [...strategyBuckets.entries()].flatMap(([strategyVersionId, rows]) => {
    const basesByCohort = new Map<string, StrategyEvalRow[]>();
    for (const row of rows) {
      if (row.evalKind !== "backtest") continue;
      const cohortId = readStrategyComparisonCohortId(row.metricsJson);
      if (!cohortId) continue;
      const bucket = basesByCohort.get(cohortId) ?? [];
      bucket.push(row);
      basesByCohort.set(cohortId, bucket);
    }
    const reviews = [...basesByCohort.entries()].flatMap(([comparisonCohortId, bases]) => {
      const baseBacktest = latest(bases);
      return baseBacktest
        ? [buildCohortStrategyReview({ strategyVersionId, comparisonCohortId, baseBacktest, rows })]
        : [];
    });
    // Preserve incomplete/legacy evidence rather than silently hiding it.
    if (
      reviews.length === 0 ||
      rows.some(
        (row) => row.evalKind === "backtest" && !readStrategyComparisonCohortId(row.metricsJson)
      )
    ) {
      reviews.push(buildUnboundStrategyReview(strategyVersionId, rows));
    }
    return reviews;
  });

  const componentBuckets = new Map<string, ComponentEvalRow[]>();
  for (const row of input.components) {
    const cohort = row.comparisonCohortId?.trim();
    if (!cohort) continue;
    const key = `${row.componentKind}\u0000${row.componentId}\u0000${cohort}`;
    const bucket = componentBuckets.get(key) ?? [];
    bucket.push(row);
    componentBuckets.set(key, bucket);
  }
  const components = [...componentBuckets.values()].map((rows) => {
    const first = rows[0];
    if (!first) throw new Error("component_review_bucket_empty");
    const versions = [...new Set(rows.map((row) => row.versionId))].sort();
    const evalKinds = [...new Set(rows.map((row) => row.evalKind))].sort();
    const sampleSize = rows.reduce((sum, row) => sum + row.sampleSize, 0);
    const allPassed = rows.every((row) => row.pass);
    return {
      componentKind: first.componentKind,
      componentId: first.componentId,
      comparisonCohortId: first.comparisonCohortId,
      versions,
      evalKinds,
      sampleSize,
      allPassed,
      promotionState:
        !evalKinds.includes("offline") ||
        (!evalKinds.includes("shadow") && !evalKinds.includes("paper"))
          ? "evidence_incomplete"
          : "manual_review_required",
      readOnly: true,
    };
  });

  return {
    readOnly: true,
    strategies: strategies.sort((left, right) =>
      `${left.strategyVersionId}:${left.comparisonCohortId ?? ""}`.localeCompare(
        `${right.strategyVersionId}:${right.comparisonCohortId ?? ""}`
      )
    ),
    components: components.sort((left, right) =>
      `${left.componentKind}:${left.componentId}`.localeCompare(
        `${right.componentKind}:${right.componentId}`
      )
    ),
  };
}

export async function getResearchIntegrityReview(
  projectId: string,
  client?: DbClient
): Promise<ReturnType<typeof buildResearchIntegrityReview>> {
  const db = client ?? (await getDb());
  const [strategies, components] = await Promise.all([
    db.select().from(strategyEvalRun).where(eq(strategyEvalRun.projectId, projectId)),
    db.select().from(componentEvalRun).where(eq(componentEvalRun.projectId, projectId)),
  ]);
  return buildResearchIntegrityReview({ strategies, components });
}
