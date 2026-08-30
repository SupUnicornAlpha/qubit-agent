import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../db/sqlite/schema";
import { strategyPromotionService } from "./strategy-promotion-service";
import { strategyCandidateReviewService } from "./strategy-candidate-review-service";

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
  return { db, projectId, championVersionId: versions[0]!, challengerVersionId: versions[1]! };
}

async function insertCohortEvidence(
  db: Awaited<ReturnType<typeof seededDb>>["db"],
  projectId: string,
  strategyVersionId: string,
  score: number
) {
  const backtestMetrics = {
    comparisonCohort: { id: cohort },
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
  for (const evalKind of ["backtest", "walk_forward", "paper"] as const) {
    await db.insert(schema.strategyEvalRun).values({
      id: randomUUID(),
      projectId,
      strategyVersionId,
      scenarioKey: "fixed-oos-shadow",
      evalKind,
      metricsJson: evalKind === "backtest" ? backtestMetrics : { comparisonCohort: { id: cohort } },
      qualityScore: score,
      pass: true,
      notes: "test",
      createdBy: "test",
    });
  }
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
});
