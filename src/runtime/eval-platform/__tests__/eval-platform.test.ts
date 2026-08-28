import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-eval-platform-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");

const { runMigrations } = await import("../../../db/sqlite/migrate");
const { closeDb, getDb } = await import("../../../db/sqlite/client");
const { workspace, project, workflowRun, llmCallLog } = await import("../../../db/sqlite/schema");
const { scorecardToDrafts } = await import("../contributors/benchmark-contributor");
const { replaceWorkflowScores } = await import("../score-writer");
const { listScores } = await import("../score-query");
const { buildObservationTree } = await import("../observation-tree");
const { scoreRunEnvelope } = await import("../../benchmark/scorecard");
import type { RunEnvelope } from "../../benchmark/contracts";

const WORKSPACE_ID = "ws-eval-platform";
const PROJECT_ID = "prj-eval-platform";

function minimalEnvelope(workflowRunId: string): RunEnvelope {
  return {
    workflowRunId,
    suite: "production",
    scenarioKey: "research",
    harnessVersion: "test",
    terminal: { status: "completed" },
    tools: [{ name: "get_quote", status: "success" }],
    artifacts: [
      {
        kind: "recommendation_snapshot",
        id: "rec-1",
        ok: true,
        asof: "2026-06-01T00:00:00.000Z",
        dataAsof: "2026-06-01T00:00:00.000Z",
      },
    ],
    artifactGate: { available: true, ok: true, missing: [], reinjectCount: 0 },
    delivery: { observed: true, hasUserFinalAnswer: true },
    contract: { telemetryAvailable: true, permanentExecutionCount: 0 },
    capability: { telemetryAvailable: true, disabledMcpExecutionCount: 0 },
  };
}

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  await db.insert(workspace).values({ id: WORKSPACE_ID, name: "eval-ws", owner: "test" });
  await db.insert(project).values({
    id: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    name: "eval-prj",
    marketScope: "US",
  });
});

afterAll(async () => {
  await closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("eval-platform P0", () => {
  test("scorecardToDrafts maps hard assertions and overall score", () => {
    const scorecard = scoreRunEnvelope(minimalEnvelope("wf-fixture"));
    const drafts = scorecardToDrafts(scorecard);
    expect(drafts.some((d) => d.name === "benchmark.overall.score")).toBe(true);
    expect(drafts.some((d) => d.name === "hard.H1.pass")).toBe(true);
    expect(drafts.find((d) => d.name === "benchmark.overall.pass")?.value.boolean).toBe(true);
  });

  test("replaceWorkflowScores is idempotent for sync sources", async () => {
    const workflowId = randomUUID();
    const db = await getDb();
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId: PROJECT_ID,
      goal: "score test",
      mode: "research",
      status: "completed",
    });

    const drafts = scorecardToDrafts(scoreRunEnvelope(minimalEnvelope(workflowId)));
    const first = await replaceWorkflowScores({ workflowRunId: workflowId, drafts });
    const second = await replaceWorkflowScores({ workflowRunId: workflowId, drafts });
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);

    const rows = await listScores({ workflowRunId: workflowId });
    expect(rows.length).toBe(first);
  });

  test("buildObservationTree projects llm and root nodes", async () => {
    const workflowId = randomUUID();
    const db = await getDb();
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId: PROJECT_ID,
      goal: "obs test",
      mode: "research",
      status: "completed",
      researchScenarioId: "research",
    });
    await db.insert(llmCallLog).values({
      id: randomUUID(),
      workflowRunId: workflowId,
      provider: "openai",
      model: "gpt-test",
      latencyMs: 120,
      status: "success",
      promptTokens: 10,
      completionTokens: 20,
    });

    const tree = await buildObservationTree(workflowId);
    expect(tree?.workflowRunId).toBe(workflowId);
    expect(tree?.root.type).toBe("workflow.root");
    expect(tree?.root.children?.some((c) => c.type === "llm.generation")).toBe(true);
  });
});
