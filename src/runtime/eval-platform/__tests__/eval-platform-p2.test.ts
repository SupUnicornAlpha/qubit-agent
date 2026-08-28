import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-eval-p2-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");

const { runMigrations } = await import("../../../db/sqlite/migrate");
const { closeDb, getDb } = await import("../../../db/sqlite/client");
const {
  workspace,
  project,
  chatSession,
  chatMessage,
  chatMessageWorkflowLink,
  workflowRun,
  evalDataset,
} = await import("../../../db/sqlite/schema");
const { rollupSessionScores } = await import("../session/session-score-rollup");
const {
  submitHumanAnnotation,
  listHumanAnnotations,
  exportWorkflowAnnotationsToGolden,
} = await import("../annotation/human-annotation-service");
const {
  submitChatMessageFeedback,
  submitWorkflowFeedback,
} = await import("../feedback/user-feedback-service");
const { assertEvalPlatformAccess } = await import("../auth/eval-access");
const { listScores } = await import("../score-query");
const { numericScore } = await import("../score-value");
const { insertScores } = await import("../score-writer");

const WORKSPACE_ID = "ws-eval-p2";
const PROJECT_ID = "prj-eval-p2";

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  await db.insert(workspace).values({ id: WORKSPACE_ID, name: "p2-ws", owner: "test" });
  await db.insert(project).values({
    id: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    name: "p2-prj",
    marketScope: "US",
  });
});

afterAll(async () => {
  delete process.env.QUBIT_EVAL_RBAC_ENABLED;
  delete process.env.QUBIT_EVAL_ROLE_MAP;
  await closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("eval-platform P2", () => {
  test("rollupSessionScores aggregates workflow scores", async () => {
    const sessionId = randomUUID();
    const db = await getDb();
    await db.insert(chatSession).values({
      id: sessionId,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      title: "rollup-session",
    });

    const wf1 = randomUUID();
    const wf2 = randomUUID();
    await db.insert(workflowRun).values([
      {
        id: wf1,
        projectId: PROJECT_ID,
        sessionId,
        goal: "g1",
        mode: "research",
        status: "completed",
      },
      {
        id: wf2,
        projectId: PROJECT_ID,
        sessionId,
        goal: "g2",
        mode: "research",
        status: "completed",
      },
    ]);

    await insertScores(wf1, [{ name: "aqm.weighted_score", ...numericScore(0.7), source: "heuristic" }], sessionId);
    await insertScores(wf2, [{ name: "aqm.weighted_score", ...numericScore(0.9), source: "heuristic" }], sessionId);

    const rollup = await rollupSessionScores(sessionId);
    expect(rollup?.workflowCount).toBe(2);
    expect(rollup?.scores.find((s) => s.name === "aqm.weighted_score")?.count).toBe(2);
    expect(rollup?.scores.find((s) => s.name === "aqm.weighted_score")?.avgNumeric).toBeCloseTo(0.8);
  });

  test("human annotation and golden export", async () => {
    const workflowId = randomUUID();
    const db = await getDb();
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId: PROJECT_ID,
      goal: "annotate-me",
      mode: "research",
      status: "completed",
    });

    const result = await submitHumanAnnotation({
      workflowRunId: workflowId,
      dataType: "NUMERIC",
      value: 0.85,
      comment: "looks good",
    });
    expect(result.written).toBe(1);

    const annotations = await listHumanAnnotations(workflowId);
    expect(annotations.length).toBe(1);
    expect(annotations[0]?.name).toBe("human.overall");

    const datasetId = randomUUID();
    await db.insert(evalDataset).values({
      id: datasetId,
      name: "golden-dataset",
      version: "v1",
      scenario: "human_golden",
      sourceDesc: "test",
    });

    const item = await exportWorkflowAnnotationsToGolden({
      datasetId,
      workflowRunId: workflowId,
      caseKey: "case-human-1",
    });
    expect(item.caseKey).toBe("case-human-1");
    expect((item.expectedJson as { humanScores?: unknown[] }).humanScores?.length).toBe(1);
  });

  test("workflow and chat feedback write user.feedback scores", async () => {
    const sessionId = randomUUID();
    const workflowId = randomUUID();
    const messageId = randomUUID();
    const db = await getDb();

    await db.insert(chatSession).values({
      id: sessionId,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      title: "feedback-session",
    });
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId: PROJECT_ID,
      sessionId,
      goal: "feedback-goal",
      mode: "research",
      status: "completed",
    });
    await db.insert(chatMessage).values({
      id: messageId,
      sessionId,
      role: "assistant",
      sender: "orchestrator",
      content: "done",
      status: "completed",
    });
    await db.insert(chatMessageWorkflowLink).values({
      id: randomUUID(),
      chatMessageId: messageId,
      workflowRunId: workflowId,
      traceId: "trace-1",
    });

    const chatFb = await submitChatMessageFeedback({
      chatMessageId: messageId,
      helpful: true,
      comment: "nice",
    });
    expect(chatFb.workflowRunId).toBe(workflowId);

    const wfFb = await submitWorkflowFeedback({
      workflowRunId: workflowId,
      helpful: false,
      comment: "too slow",
    });
    expect(wfFb.written).toBe(1);

    const scores = await listScores({ workflowRunId: workflowId });
    expect(scores.some((s) => s.name === "user.feedback.helpful")).toBe(true);
    expect(scores.filter((s) => s.name === "user.feedback.helpful").length).toBeGreaterThanOrEqual(2);
  });

  test("RBAC blocks annotate when role is viewer", () => {
    process.env.QUBIT_EVAL_RBAC_ENABLED = "1";
    process.env.QUBIT_EVAL_ROLE_MAP = JSON.stringify({ alice: "viewer" });

    expect(() =>
      assertEvalPlatformAccess({ action: "annotate", actor: "alice" })
    ).toThrow("eval_platform_forbidden");

    expect(() =>
      assertEvalPlatformAccess({ action: "view", actor: "alice" })
    ).not.toThrow();
  });
});
