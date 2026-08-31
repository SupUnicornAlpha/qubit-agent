import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../db/sqlite/schema";
import {
  buildComponentScorecards,
  componentChallengerService,
  resolveShadowVariant,
} from "./component-challenger-service";

describe("component challenger governance", () => {
  test("requires samples and passing evidence", () => {
    const rows = [
      {
        versionId: "v1",
        comparisonCohortId: "cohort-1",
        sampleSize: 10,
        qualityScore: 0.9,
        pass: true,
        evalKind: "offline",
      },
      {
        versionId: "v2",
        comparisonCohortId: "cohort-1",
        sampleSize: 10,
        qualityScore: 0.8,
        pass: true,
        evalKind: "offline",
      },
      {
        versionId: "v2",
        comparisonCohortId: "cohort-1",
        sampleSize: 10,
        qualityScore: 0.8,
        pass: true,
        evalKind: "shadow",
      },
    ] as never;
    const cards = buildComponentScorecards(rows, 20);
    expect(cards.find((card) => card.versionId === "v1")?.eligible).toBe(false);
    expect(cards.find((card) => card.versionId === "v2")?.eligible).toBe(true);
  });

  test("never aggregates component evidence across benchmark cohorts", () => {
    const cards = buildComponentScorecards(
      [
        {
          versionId: "v1",
          comparisonCohortId: "cohort-a",
          sampleSize: 20,
          qualityScore: 1,
          pass: true,
          evalKind: "offline",
        },
        {
          versionId: "v1",
          comparisonCohortId: "cohort-b",
          sampleSize: 20,
          qualityScore: 1,
          pass: true,
          evalKind: "shadow",
        },
      ] as never,
      20
    );
    expect(cards).toHaveLength(2);
    expect(cards.every((card) => card.eligible === false)).toBe(true);
  });

  test("never routes live traffic to challenger", () => {
    expect(
      resolveShadowVariant({
        allocationKey: "run-1",
        challengerTrafficPct: 1,
        executionMode: "live",
      })
    ).toBe("control");
    expect(["control", "challenger"]).toContain(
      resolveShadowVariant({
        allocationKey: "run-2",
        challengerTrafficPct: 0.1,
        executionMode: "paper",
      })
    );
  });

  test("promotes only versions evaluated on the requested frozen cohort", async () => {
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
    const cohort = "benchmark-cohort-a";
    for (const [versionId, qualityScore] of [
      ["control-v1", 0.7],
      ["challenger-v2", 0.8],
    ] as const) {
      for (const evalKind of ["offline", "shadow"] as const) {
        await componentChallengerService.record(
          {
            projectId,
            componentKind: "harness",
            componentId: "math-audit",
            versionId,
            comparisonCohortId: cohort,
            evalKind,
            sampleSize: 20,
            metrics: { frozenInputFingerprint: cohort },
            qualityScore,
            pass: true,
          },
          db
        );
      }
    }
    // A perfect but incompatible benchmark must not affect the cohort-a decision.
    await componentChallengerService.record(
      {
        projectId,
        componentKind: "harness",
        componentId: "math-audit",
        versionId: "control-v1",
        comparisonCohortId: "benchmark-cohort-b",
        evalKind: "offline",
        sampleSize: 10_000,
        metrics: { frozenInputFingerprint: "benchmark-cohort-b" },
        qualityScore: 1,
        pass: true,
      },
      db
    );

    const result = await componentChallengerService.compare(
      {
        projectId,
        componentKind: "harness",
        componentId: "math-audit",
        challengerVersionId: "challenger-v2",
        championVersionId: "control-v1",
        comparisonCohortId: cohort,
        minimumScoreUplift: 0.03,
      },
      db
    );
    expect(result.promotionEligible).toBe(true);
    expect(result.champion?.score).toBe(0.7);
    expect(result.challenger?.score).toBe(0.8);
    expect(result.scorecards.every((card) => card.comparisonCohortId === cohort)).toBe(true);
  });
});
