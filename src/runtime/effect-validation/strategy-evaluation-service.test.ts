import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../db/sqlite/schema";
import {
  assessStrategyExecutionAdmission,
  hasPassedBacktestCoreIntegrity,
  hasPassedBacktestIntegrity,
} from "./strategy-evaluation-service";

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
  await db.insert(schema.strategyVersion).values({
    id: strategyVersionId,
    strategyId,
    versionTag: "v1",
    logicHash: "logic",
    paramSchemaJson: {},
  });
  return { db, projectId, strategyVersionId };
}

describe("strategy live deployment admission", () => {
  test("base integrity may defer only OOS to the mandatory walk-forward gate", () => {
    expect(
      hasPassedBacktestCoreIntegrity({
        status: "research_only",
        failedChecks: [],
        unknownChecks: ["oos_isolation"],
      })
    ).toBe(true);
    expect(
      hasPassedBacktestCoreIntegrity({
        status: "research_only",
        failedChecks: [],
        unknownChecks: ["survivorship_bias", "oos_isolation"],
      })
    ).toBe(false);
    expect(
      hasPassedBacktestIntegrity({
        antiLeakageReport: {
          status: "research_only",
          failedChecks: [],
          unknownChecks: ["oos_isolation"],
        },
        pitReport: { pass: true, verdict: "point_in_time_clean" },
        statisticalValidationReport: { status: "passed" },
      })
    ).toBe(true);
    expect(
      hasPassedBacktestIntegrity({
        antiLeakageReport: {
          status: "research_only",
          failedChecks: [],
          unknownChecks: ["oos_isolation"],
        },
        pitReport: { pass: true, verdict: "point_in_time_clean" },
        statisticalValidationReport: { status: "research_only" },
      })
    ).toBe(false);
    expect(
      hasPassedBacktestIntegrity({
        antiLeakageReport: {
          status: "research_only",
          failedChecks: [],
          unknownChecks: ["oos_isolation"],
        },
        pitReport: { pass: false, verdict: "point_in_time_violated" },
        statisticalValidationReport: { status: "passed" },
      })
    ).toBe(false);
  });

  test("base integrity may defer both OOS and embargo to walk-forward", () => {
    expect(
      hasPassedBacktestCoreIntegrity({
        status: "research_only",
        failedChecks: [],
        unknownChecks: ["oos_isolation", "embargo_isolation"],
      })
    ).toBe(true);
  });

  test("rejects a research-only backtest even when its performance gate passed", async () => {
    const { db, projectId, strategyVersionId } = await seededDb();
    await db.insert(schema.strategyEvalRun).values({
      id: randomUUID(),
      projectId,
      strategyVersionId,
      backtestRunId: null,
      evalKind: "backtest",
      metricsJson: {
        datasetSnapshotId: "snap-research",
        datasetQualification: {
          useClass: "research_only",
          universeHistory: "not_verified",
          corporateActions: "not_verified",
          pointInTime: "verified",
        },
      },
      pass: true,
    });

    const admission = await assessStrategyExecutionAdmission(db, strategyVersionId);
    expect(admission.eligible).toBe(false);
    expect(admission.code).toBe("strategy_dataset_not_validation_qualified");
    expect(admission.datasetSnapshotId).toBe("snap-research");
  });

  test("requires both a validation-qualified dataset and a passed evaluation", async () => {
    const { db, projectId, strategyVersionId } = await seededDb();
    const qualification = {
      useClass: "strategy_validation",
      universeHistory: "verified",
      corporateActions: "verified",
      pointInTime: "verified",
    };
    const evaluationId = randomUUID();
    await db.insert(schema.strategyEvalRun).values({
      id: evaluationId,
      projectId,
      strategyVersionId,
      evalKind: "backtest",
      metricsJson: {
        datasetSnapshotId: "snap-validation",
        datasetQualification: qualification,
        antiLeakageReport: { status: "passed" },
        pitReport: { pass: true, verdict: "point_in_time_clean" },
        statisticalValidationReport: { status: "passed" },
      },
      pass: false,
    });
    const blocked = await assessStrategyExecutionAdmission(db, strategyVersionId);
    expect(blocked.code).toBe("strategy_evaluation_failed");

    await db
      .update(schema.strategyEvalRun)
      .set({ pass: true })
      .where(eq(schema.strategyEvalRun.id, evaluationId));
    const promotionBlocked = await assessStrategyExecutionAdmission(db, strategyVersionId);
    expect(promotionBlocked.code).toBe("strategy_promotion_incomplete");

    for (const evalKind of ["walk_forward", "paper", "live"] as const) {
      await db.insert(schema.strategyEvalRun).values({
        id: randomUUID(),
        projectId,
        strategyVersionId,
        evalKind,
        metricsJson: {},
        pass: true,
      });
    }
    const admitted = await assessStrategyExecutionAdmission(db, strategyVersionId);
    expect(admitted.eligible).toBe(true);
    expect(admitted.code).toBe("strategy_execution_admitted");
  });
});
