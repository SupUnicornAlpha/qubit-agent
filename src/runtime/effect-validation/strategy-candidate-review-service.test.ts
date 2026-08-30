import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../db/sqlite/schema";
import { strategyCandidateReviewService } from "./strategy-candidate-review-service";

async function seededDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  const db = drizzle(sqlite, { schema });
  await migrate(db, {
    migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "../../db/sqlite/migrations"),
  });
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const strategyId = randomUUID();
  const strategyVersionId = randomUUID();
  const duplicateVersionId = randomUUID();
  await db.insert(schema.workspace).values({ id: workspaceId, name: "w", owner: "test" });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "p",
    marketScope: "US",
    status: "active",
  });
  await db.insert(schema.strategy).values({
    id: strategyId,
    projectId,
    name: "s",
    style: "low_freq",
    description: "",
  });
  await db.insert(schema.strategyVersion).values([
    { id: strategyVersionId, strategyId, versionTag: "v1", logicHash: "one", paramSchemaJson: {} },
    { id: duplicateVersionId, strategyId, versionTag: "v2", logicHash: "two", paramSchemaJson: {} },
  ]);
  return { db, projectId, strategyVersionId, duplicateVersionId };
}

describe("strategy candidate review graveyard", () => {
  test("persists a rejected candidate with regime/capacity/correlation evidence and upserts by cohort", async () => {
    const { db, projectId, strategyVersionId, duplicateVersionId } = await seededDb();
    const input = {
      projectId,
      strategyVersionId,
      comparisonCohortId: "strategy_cohort_0123456789abcdef01234567",
      decision: "rejected" as const,
      reasonCodes: ["crowded", "capacity_insufficient", "crowded"],
      duplicateOfStrategyVersionId: duplicateVersionId,
      regimeEvidence: [{ regime: "high_volatility", sharpe: -0.4 }],
      capacityEvidence: { estimatedCapacityUsd: 100_000, requiredCapacityUsd: 1_000_000 },
      correlationEvidence: { championCorrelation: 0.91 },
      createdBy: "test",
    };
    const first = await strategyCandidateReviewService.record(input, db);
    expect(first).toMatchObject({ decision: "rejected", reasonCodesJson: ["capacity_insufficient", "crowded"] });
    const second = await strategyCandidateReviewService.record(
      { ...input, reasonCodes: ["duplicate_strategy"] },
      db
    );
    expect(second?.id).toBe(first?.id);
    expect((await strategyCandidateReviewService.list(projectId, db)).length).toBe(1);
    expect(second?.reasonCodesJson).toEqual(["duplicate_strategy"]);
  });

  test("requires reason evidence for non-eligible decisions and rejects cross-project versions", async () => {
    const { db, projectId, strategyVersionId } = await seededDb();
    await expect(
      strategyCandidateReviewService.record(
        {
          projectId,
          strategyVersionId,
          comparisonCohortId: "review_missing_evidence",
          decision: "rejected",
          reasonCodes: [],
        },
        db
      )
    ).rejects.toThrow("strategy_candidate_review_reason_required");
    await expect(
      strategyCandidateReviewService.record(
        {
          projectId: randomUUID(),
          strategyVersionId,
          comparisonCohortId: "review_wrong_project",
          decision: "eligible",
          reasonCodes: [],
        },
        db
      )
    ).rejects.toThrow("strategy_candidate_review_strategy_version_not_found");
  });

  test("labels only an exact same-project structure as a duplicate", async () => {
    const { db, projectId, strategyVersionId, duplicateVersionId } = await seededDb();
    await db.insert(schema.strategyComposition).values({
      id: randomUUID(),
      strategyVersionId: duplicateVersionId,
      kind: "factor_score",
      factorIdsJson: ["factor_b", "factor_a"],
      ruleIdsJson: [],
      weightMethod: "equal",
      rebalanceFreq: "1d",
      universe: "US",
      paramsJson: { topN: 20, nested: { z: 2, a: 1 } },
    });
    await db.insert(schema.strategyComposition).values({
      id: randomUUID(),
      strategyVersionId,
      kind: "factor_score",
      factorIdsJson: ["factor_a", "factor_b"],
      ruleIdsJson: [],
      weightMethod: "equal",
      rebalanceFreq: "1d",
      universe: "US",
      paramsJson: { nested: { a: 1, z: 2 }, topN: 20 },
    });

    const review = await strategyCandidateReviewService.record(
      {
        projectId,
        strategyVersionId,
        comparisonCohortId: "review_exact_structure",
        decision: "rejected",
        reasonCodes: ["insufficient_oos_uplift"],
      },
      db
    );
    expect(review?.duplicateOfStrategyVersionId).toBe(duplicateVersionId);
    expect(review?.reasonCodesJson).toEqual([
      "exact_structural_duplicate",
      "insufficient_oos_uplift",
    ]);
  });
});
