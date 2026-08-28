import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-eval-p1-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");

const { runMigrations } = await import("../../../db/sqlite/migrate");
const { closeDb, getDb } = await import("../../../db/sqlite/client");
const { workspace, project, evalDataset, workflowRun, evalRun, evalCaseResult } = await import(
  "../../../db/sqlite/schema"
);
const { shouldSampleWorkflow } = await import("../evaluators/sampling");
const { setEvaluatorConfigsForTesting } = await import("../evaluators/registry");
const {
  createDatasetItem,
  addWorkflowToDataset,
  listDatasetItems,
} = await import("../dataset/dataset-item-service");
const { diffExperimentRuns } = await import("../experiment/experiment-runner");
const { compareScoreWindows } = await import("../analytics/score-analytics");
const { replaceWorkflowScores } = await import("../score-writer");
const { numericScore } = await import("../score-value");

const WORKSPACE_ID = "ws-eval-p1";
const PROJECT_ID = "prj-eval-p1";

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  await db.insert(workspace).values({ id: WORKSPACE_ID, name: "p1-ws", owner: "test" });
  await db.insert(project).values({
    id: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    name: "p1-prj",
    marketScope: "US",
  });
});

afterAll(async () => {
  setEvaluatorConfigsForTesting(null);
  await closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("eval-platform P1", () => {
  test("shouldSampleWorkflow is deterministic", () => {
    expect(shouldSampleWorkflow("wf-a", 0)).toBe(false);
    expect(shouldSampleWorkflow("wf-a", 1)).toBe(true);
    const a = shouldSampleWorkflow("wf-stable-id", 0.5);
    const b = shouldSampleWorkflow("wf-stable-id", 0.5);
    expect(a).toBe(b);
  });

  test("dataset item CRUD and add-from-trace", async () => {
    const db = await getDb();
    const datasetId = randomUUID();
    await db.insert(evalDataset).values({
      id: datasetId,
      name: "p1-dataset",
      version: "v1",
      scenario: "agent_benchmark",
      sourceDesc: "test",
    });

    const workflowId = randomUUID();
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId: PROJECT_ID,
      goal: "trace goal",
      mode: "research",
      status: "completed",
      researchScenarioId: "research",
    });

    const fromTrace = await addWorkflowToDataset({ datasetId, workflowRunId: workflowId });
    expect(fromTrace.sourceWorkflowRunId).toBe(workflowId);

    await createDatasetItem({
      datasetId,
      caseKey: "manual-1",
      inputJson: { scenarioKey: "research", goal: "x", projectId: PROJECT_ID, inputParams: {} },
    });

    const items = await listDatasetItems(datasetId);
    expect(items.length).toBe(2);
  });

  test("diffExperimentRuns compares case scores", async () => {
    const db = await getDb();
    const datasetId = randomUUID();
    await db.insert(evalDataset).values({
      id: datasetId,
      name: "diff-dataset",
      version: "v1",
      scenario: "test",
      sourceDesc: "test",
    });
    const baselineRunId = randomUUID();
    const challengerRunId = randomUUID();
    await db.insert(evalRun).values([
      { id: baselineRunId, datasetId, status: "completed" },
      { id: challengerRunId, datasetId, status: "completed" },
    ]);
    await db.insert(evalCaseResult).values([
      {
        id: randomUUID(),
        evalRunId: baselineRunId,
        caseKey: "c1",
        score: 0.5,
        pass: false,
      },
      {
        id: randomUUID(),
        evalRunId: challengerRunId,
        caseKey: "c1",
        score: 0.8,
        pass: true,
      },
    ]);

    const diff = await diffExperimentRuns(baselineRunId, challengerRunId);
    expect(diff.rows[0]?.delta).toBeCloseTo(0.3);
    expect(diff.summary.improved).toBe(1);
  });

  test("compareScoreWindows computes delta", async () => {
    const workflowRecent = randomUUID();
    const workflowBaseline = randomUUID();
    const db = await getDb();
    await db.insert(workflowRun).values([
      {
        id: workflowRecent,
        projectId: PROJECT_ID,
        goal: "analytics-recent",
        mode: "research",
        status: "completed",
      },
      {
        id: workflowBaseline,
        projectId: PROJECT_ID,
        goal: "analytics-base",
        mode: "research",
        status: "completed",
      },
    ]);

    const now = Date.now();
    const recentAt = new Date(now - 2 * 86_400_000).toISOString();
    const baselineAt = new Date(now - 10 * 86_400_000).toISOString();

    const sqlite = (await import("../../../db/sqlite/client")).getSqliteForTesting();
    sqlite
      .prepare(
        `INSERT INTO agent_score
         (id, name, data_type, value_numeric, source, workflow_run_id, created_at)
         VALUES (?, 'aqm.weighted_score', 'NUMERIC', 0.8, 'heuristic', ?, ?)`
      )
      .run(randomUUID(), workflowRecent, recentAt);
    sqlite
      .prepare(
        `INSERT INTO agent_score
         (id, name, data_type, value_numeric, source, workflow_run_id, created_at)
         VALUES (?, 'aqm.weighted_score', 'NUMERIC', 0.4, 'heuristic', ?, ?)`
      )
      .run(randomUUID(), workflowBaseline, baselineAt);

    const comparison = await compareScoreWindows({ name: "aqm.weighted_score", recentDays: 7 });
    expect(comparison.recentCount).toBeGreaterThan(0);
    expect(comparison.baselineCount).toBeGreaterThan(0);
    expect(comparison.deltaPct).toBeGreaterThan(0);
  });
});
