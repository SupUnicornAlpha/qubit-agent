import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = join(tmpdir(), `qubit-recommendation-service-${process.pid}-${Date.now()}`);
rmSync(testDir, { recursive: true, force: true });
mkdirSync(join(testDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = testDir;
process.env.HOME = testDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { closeDb, getDb } = await import("../../db/sqlite/client");
const { runMigrations } = await import("../../db/sqlite/migrate");
const { project, workspace, workflowRun } = await import("../../db/sqlite/schema");
const { computeDeterministicPositionSizePct, recommendationService } = await import(
  "./recommendation-service"
);

const projectId = "project-recommendation-test";
const workflowRunId = "workflow-recommendation-test";

describe("RecommendationService", () => {
  test("deterministic sizing uses stop distance and risk budget", () => {
    expect(
      computeDeterministicPositionSizePct({
        entryHigh: 100,
        entryLow: 98,
        stopLoss: 95,
        confidence: 0.8,
        positionSizePct: 0.9,
      })
    ).toBeCloseTo(0.18, 6);
  });

  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(workspace)
      .values({ id: "workspace-recommendation-test", name: "ws", owner: "test" });
    await db.insert(project).values({
      id: projectId,
      workspaceId: "workspace-recommendation-test",
      name: "project",
      marketScope: "US",
    });
    await db.insert(workflowRun).values({
      id: workflowRunId,
      projectId,
      goal: "pick stock",
      mode: "research",
      source: "api",
      status: "completed",
      researchScenarioId: "stock_pick",
    });
  });

  afterAll(async () => {
    await closeDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  test("records structured signal and aggregates mature outcome", async () => {
    const created = await recommendationService.record({
      workflowRunId,
      symbol: "aapl",
      side: "long",
      horizonDays: 5,
      confidence: 0.72,
      entryLow: 98,
      entryHigh: 100,
      stopLoss: 94,
      takeProfit: 112,
      positionSizePct: 0.2,
      invalidation: ["跌破关键支撑"],
      evidence: [{ source: "test" }],
      asof: "2026-01-01T00:00:00.000Z",
    });
    await recommendationService.recordOutcome({
      recommendationId: created.id,
      horizonDays: 1,
      entryPrice: 100,
      exitPrice: 104,
      returnPct: 4,
      benchmarkReturnPct: 1,
      excessReturnPct: 3,
      hit: true,
      outcome: "win",
      maxAdverseExcursionPct: -2,
      maxFavorableExcursionPct: 5,
      barsObserved: 2,
      evaluatedAt: "2026-01-03T00:00:00.000Z",
    });
    await recommendationService.recordOutcome({
      recommendationId: created.id,
      horizonDays: 5,
      entryPrice: 100,
      exitPrice: 112,
      returnPct: 12,
      benchmarkReturnPct: 2,
      excessReturnPct: 10,
      hit: true,
      outcome: "win",
      maxAdverseExcursionPct: -3,
      maxFavorableExcursionPct: 13,
      takeProfitTriggered: true,
      barsObserved: 4,
      evaluatedAt: "2026-01-08T00:00:00.000Z",
    });
    await recommendationService.setStatus(created.id, "closed");

    const rows = await recommendationService.list({ projectId });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.symbol).toBe("AAPL");
    expect(rows[0]?.riskRewardRatio).toBe(2);
    expect(rows[0]?.positionSizePct).toBeCloseTo(0.143333, 6);
    expect(rows[0]?.outcome?.takeProfitTriggered).toBe(true);
    expect(rows[0]?.outcomes.map((outcome) => outcome.horizonDays)).toEqual([1, 5]);

    const stats = await recommendationService.stats(projectId);
    expect(stats.mature).toBe(1);
    expect(stats.winRatePct).toBe(100);
    expect(stats.avgExcessReturnPct).toBe(10);
    expect(stats.horizonStats.find((item) => item.horizonDays === 1)?.avgMaePct).toBe(-2);
    const fiveDay = stats.horizonStats.find((item) => item.horizonDays === 5);
    expect(fiveDay?.brierScore).toBeCloseTo(0.0784, 4);
    expect(fiveDay?.ece).toBeCloseTo(0.28, 4);
    expect(fiveDay?.calibrationBins[3]?.count).toBe(1);
  });
});
