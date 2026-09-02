import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../db/sqlite/schema";
import { createFinalHoldoutContract } from "../backtest/final-holdout-contract";
import { strategyCandidateReviewService } from "./strategy-candidate-review-service";
import { strategyPromotionService } from "./strategy-promotion-service";
import { assessStrategyRecipeEvidence } from "./strategy-recipe-evidence";

const cohort = "strategy_cohort_0123456789abcdef01234567";

async function seededDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  const db = drizzle(sqlite, { schema });
  await migrate(db, {
    migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "../../db/sqlite/migrations"),
  });
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.insert(schema.workspace).values({ id: workspaceId, name: "w", owner: "test" });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "p",
    marketScope: "US",
    status: "active",
  });
  const versions: string[] = [];
  for (const name of ["champion", "challenger"]) {
    const strategyId = randomUUID();
    const versionId = randomUUID();
    await db.insert(schema.strategy).values({
      id: strategyId,
      projectId,
      name,
      style: "low_freq",
      description: "",
    });
    await db.insert(schema.strategyVersion).values({
      id: versionId,
      strategyId,
      versionTag: "v1",
      logicHash: name,
      paramSchemaJson: {},
    });
    versions.push(versionId);
  }
  const [championVersionId, challengerVersionId] = versions;
  if (!championVersionId || !challengerVersionId) throw new Error("expected two strategy versions");
  return { db, projectId, championVersionId, challengerVersionId };
}

async function insertCohortEvidence(
  db: Awaited<ReturnType<typeof seededDb>>["db"],
  projectId: string,
  strategyVersionId: string,
  score: number
) {
  const datasetSnapshotId = `snapshot-${strategyVersionId}`;
  const backtestMetrics = {
    comparisonCohort: { id: cohort },
    datasetSnapshotId,
    datasetQualification: {
      useClass: "strategy_validation",
      universeHistory: "verified",
      corporateActions: "verified",
      pointInTime: "verified",
    },
    antiLeakageReport: { status: "passed" },
    pitReport: { pass: true, verdict: "point_in_time_clean" },
    statisticalValidationReport: { status: "passed" },
  };
  for (const evalKind of ["backtest", "walk_forward", "holdout", "paper"] as const) {
    await db.insert(schema.strategyEvalRun).values({
      id: randomUUID(),
      projectId,
      strategyVersionId,
      scenarioKey: "fixed-oos-shadow",
      evalKind,
      metricsJson:
        evalKind === "backtest"
          ? backtestMetrics
          : evalKind === "holdout"
            ? {
                contract: createFinalHoldoutContract({
                  strategyVersionId,
                  datasetSnapshotId,
                  trainEnd: "2026-01-31",
                  holdoutStart: "2026-02-06",
                  holdoutEnd: "2026-02-28",
                  purgeDays: 5,
                  embargoDays: 5,
                }),
              }
            : evalKind === "walk_forward"
              ? {
                  comparisonCohort: { id: cohort },
                  oosReturnSeries: oosReturns(score >= 0.8 ? "challenger" : "champion"),
                }
              : { comparisonCohort: { id: cohort } },
      qualityScore: score,
      pass: true,
      notes: "test",
      createdBy: "test",
    });
  }
}

async function setWalkForwardOosReturns(
  db: Awaited<ReturnType<typeof seededDb>>["db"],
  strategyVersionId: string,
  oosReturnSeries: unknown
) {
  const row = (
    await db
      .select()
      .from(schema.strategyEvalRun)
      .where(
        and(
          eq(schema.strategyEvalRun.strategyVersionId, strategyVersionId),
          eq(schema.strategyEvalRun.evalKind, "walk_forward")
        )
      )
      .limit(1)
  )[0];
  if (!row) throw new Error("walk_forward_fixture_missing");
  const metrics =
    row.metricsJson && typeof row.metricsJson === "object" && !Array.isArray(row.metricsJson)
      ? row.metricsJson
      : {};
  await db
    .update(schema.strategyEvalRun)
    .set({ metricsJson: { ...metrics, oosReturnSeries } })
    .where(eq(schema.strategyEvalRun.id, row.id));
}

function oosReturns(kind: "champion" | "challenger") {
  const values =
    kind === "champion"
      ? [0.02, -0.015, 0.018, -0.012, 0.02, -0.016, 0.017, -0.01]
      : [0.004, 0.005, 0.006, 0.004, 0.005, 0.006, 0.004, 0.005];
  return Array.from({ length: 64 }, (_, index) => ({
    timestamp: `2026-03-${String(index + 1).padStart(2, "0")}`,
    return: values[index % values.length] ?? 0,
  }));
}

describe("strategy promotion fixed-cohort gate", () => {
  test("compares a challenger only on the matching frozen OOS/shadow cohort", async () => {
    const { db, projectId, championVersionId, challengerVersionId } = await seededDb();
    await insertCohortEvidence(db, projectId, championVersionId, 0.7);
    await insertCohortEvidence(db, projectId, challengerVersionId, 0.9);

    const result = await strategyPromotionService.compareVersions(
      { projectId, challengerStrategyVersionId: challengerVersionId, minimumScoreUplift: 0.03 },
      db
    );
    expect(result.comparisonCohortId).toBe(cohort);
    expect(result.champion?.strategyVersionId).toBe(championVersionId);
    expect(result.challenger?.strategyVersionId).toBe(challengerVersionId);
    expect(result.decision).toBe("candidate_for_manual_promotion");
    expect(result.promotionEligible).toBe(true);
    const reviews = await strategyCandidateReviewService.list(projectId, db);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      strategyVersionId: challengerVersionId,
      comparisonCohortId: cohort,
      decision: "eligible",
    });
  });

  test("fails closed when a matching cohort has no auditable OOS return series", async () => {
    const { db, projectId, championVersionId, challengerVersionId } = await seededDb();
    await insertCohortEvidence(db, projectId, championVersionId, 0.7);
    await insertCohortEvidence(db, projectId, challengerVersionId, 0.9);
    await setWalkForwardOosReturns(db, challengerVersionId, []);

    const result = await strategyPromotionService.compareVersions(
      { projectId, challengerStrategyVersionId: challengerVersionId },
      db
    );
    expect(result.decision).toBe("challenger_diversification_evidence_missing_or_failed");
    expect(result.promotionEligible).toBe(false);
    expect(result.diversification.status).toBe("insufficient_evidence");
    expect((await strategyCandidateReviewService.list(projectId, db))[0]).toMatchObject({
      decision: "incomplete",
    });
  });

  test("rejects a high-correlation challenger even when its weighted score is higher", async () => {
    const { db, projectId, championVersionId, challengerVersionId } = await seededDb();
    await insertCohortEvidence(db, projectId, championVersionId, 0.7);
    await insertCohortEvidence(db, projectId, challengerVersionId, 0.9);
    await setWalkForwardOosReturns(db, challengerVersionId, oosReturns("champion"));

    const result = await strategyPromotionService.compareVersions(
      { projectId, challengerStrategyVersionId: challengerVersionId },
      db
    );
    expect(result.decision).toBe("challenger_diversification_evidence_missing_or_failed");
    expect(result.promotionEligible).toBe(false);
    expect(result.diversification.status).toBe("correlation_too_high");
    expect((await strategyCandidateReviewService.list(projectId, db))[0]).toMatchObject({
      decision: "rejected",
    });
  });

  test("strategy recipe requires evidence from its exact composition", async () => {
    const { db, projectId, championVersionId } = await seededDb();
    const compositionId = randomUUID();
    const backtestRunId = randomUUID();
    const datasetSnapshotId = "recipe-validation-snapshot";
    await db.insert(schema.strategyComposition).values({
      id: compositionId,
      strategyVersionId: championVersionId,
      kind: "factor_score",
      factorIdsJson: [],
      ruleIdsJson: [],
      weightMethod: "equal",
      rebalanceFreq: "1d",
      universe: "US",
      paramsJson: {},
    });
    await db.insert(schema.backtestRun).values({
      id: backtestRunId,
      strategyVersionId: championVersionId,
      connectorInstanceId: "fixture",
      datasetSnapshotId,
      configJson: {},
      status: "completed",
      compositionId,
    });
    const backtestMetrics = {
      comparisonCohort: { id: cohort },
      datasetSnapshotId,
      datasetQualification: {
        useClass: "strategy_validation",
        universeHistory: "verified",
        corporateActions: "verified",
        pointInTime: "verified",
      },
      antiLeakageReport: { status: "passed" },
      pitReport: { pass: true, verdict: "point_in_time_clean" },
      statisticalValidationReport: { status: "passed" },
    };
    for (const evalKind of ["backtest", "walk_forward", "holdout", "paper"] as const) {
      await db.insert(schema.strategyEvalRun).values({
        id: randomUUID(),
        projectId,
        strategyVersionId: championVersionId,
        compositionId,
        backtestRunId: evalKind === "paper" ? null : backtestRunId,
        scenarioKey: "recipe-proof",
        evalKind,
        metricsJson:
          evalKind === "backtest"
            ? backtestMetrics
            : evalKind === "holdout"
              ? {
                  contract: createFinalHoldoutContract({
                    strategyVersionId: championVersionId,
                    datasetSnapshotId,
                    trainEnd: "2026-01-31",
                    holdoutStart: "2026-02-06",
                    holdoutEnd: "2026-02-28",
                    purgeDays: 5,
                    embargoDays: 5,
                  }),
                }
              : { comparisonCohort: { id: cohort } },
        qualityScore: 0.8,
        pass: true,
        notes: "recipe-proof",
        createdBy: "test",
      });
    }
    const eligible = await assessStrategyRecipeEvidence({ projectId, compositionId, client: db });
    expect(eligible.eligible).toBe(true);
    if (eligible.eligible) {
      expect(eligible.evidence).toMatchObject({
        compositionId,
        backtestRunId,
        datasetSnapshotId,
      });
    }

    await db
      .update(schema.strategyEvalRun)
      .set({ compositionId: null })
      .where(eq(schema.strategyEvalRun.evalKind, "paper"));
    const missingExactPaper = await assessStrategyRecipeEvidence({
      projectId,
      compositionId,
      client: db,
    });
    expect(missingExactPaper.eligible).toBe(false);
  });
});
