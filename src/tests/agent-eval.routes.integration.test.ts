import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../db/sqlite/client";
import { runMigrations } from "../db/sqlite/migrate";
import {
  chatMessage,
  chatMessageWorkflowLink,
  chatSession,
  evalDataset,
  evalRun,
  evalCaseResult,
  project,
  workflowRun,
  workspace,
} from "../db/sqlite/schema";
import { insertScores } from "../runtime/eval-platform/score-writer";
import { numericScore } from "../runtime/eval-platform/score-value";

async function jsonOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("agent-eval routes integration", () => {
  let app: { request: (req: Request) => Promise<Response> };
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const workflowId = randomUUID();
  const datasetId = randomUUID();

  beforeAll(async () => {
    const testHome = `${process.cwd()}/.tmp-agent-eval-route-home`;
    await rm(testHome, { recursive: true, force: true });
    await mkdir(testHome, { recursive: true });
    process.env.HOME = testHome;
    closeDb();
    await runMigrations();
    const server = await import("../server");
    app = server.app;

    const db = await getDb();
    await db.insert(workspace).values({ id: workspaceId, name: "eval-route-ws", owner: "test" });
    await db.insert(project).values({
      id: projectId,
      workspaceId,
      name: "eval-route-prj",
      marketScope: "US",
    });
    await db.insert(chatSession).values({
      id: sessionId,
      workspaceId,
      projectId,
      title: "eval-route-session",
    });
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId,
      sessionId,
      goal: "route-test",
      mode: "research",
      status: "completed",
    });
    await insertScores(
      workflowId,
      [{ name: "aqm.weighted_score", ...numericScore(0.75), source: "heuristic" }],
      sessionId
    );
    await db.insert(evalDataset).values({
      id: datasetId,
      name: "route-dataset",
      version: "v1",
      scenario: "test",
      sourceDesc: "integration",
    });
  });

  test("GET /scores returns workflow scores", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/agent-eval/scores?workflowRunId=${workflowId}`)
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    const data = body.data as Array<{ name: string }>;
    expect(data.some((row) => row.name === "aqm.weighted_score")).toBe(true);
  });

  test("GET /scores/analytics/compare returns delta", async () => {
    const res = await app.request(
      new Request(
        "http://test/api/v1/agent-eval/scores/analytics/compare?name=aqm.weighted_score&recentDays=7"
      )
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect((body.data as { name: string }).name).toBe("aqm.weighted_score");
  });

  test("GET /sessions/:sessionId/scores returns rollup", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/agent-eval/sessions/${sessionId}/scores`)
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    const data = body.data as { workflowCount: number; scores: Array<{ name: string }> };
    expect(data.workflowCount).toBeGreaterThan(0);
    expect(data.scores.some((s) => s.name === "aqm.weighted_score")).toBe(true);
  });

  test("POST /workflows/:id/annotations writes human score", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/agent-eval/workflows/${workflowId}/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dataType: "NUMERIC", value: 0.9, comment: "route-test" }),
      })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect((body.data as { written: number }).written).toBe(1);
  });

  test("GET /experiments/diff compares runs", async () => {
    const db = await getDb();
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
        score: 0.4,
        pass: false,
      },
      {
        id: randomUUID(),
        evalRunId: challengerRunId,
        caseKey: "c1",
        score: 0.9,
        pass: true,
      },
    ]);

    const res = await app.request(
      new Request(
        `http://test/api/v1/agent-eval/experiments/diff?baselineRunId=${baselineRunId}&challengerRunId=${challengerRunId}`
      )
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    const data = body.data as { rows: Array<{ delta: number }> };
    expect(data.rows[0]?.delta).toBeCloseTo(0.5);
  });

  test("POST /chat-messages/:id/feedback requires linked workflow", async () => {
    const messageId = randomUUID();
    const db = await getDb();
    await db.insert(chatMessage).values({
      id: messageId,
      sessionId,
      role: "assistant",
      sender: "orchestrator",
      content: "hello",
      status: "completed",
    });
    await db.insert(chatMessageWorkflowLink).values({
      id: randomUUID(),
      chatMessageId: messageId,
      workflowRunId: workflowId,
      traceId: "trace-route",
    });

    const res = await app.request(
      new Request(`http://test/api/v1/agent-eval/chat-messages/${messageId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ helpful: true }),
      })
    );
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect((body.data as { workflowRunId: string }).workflowRunId).toBe(workflowId);
  });

  test("GET /scores without filter returns 400", async () => {
    const res = await app.request(new Request("http://test/api/v1/agent-eval/scores"));
    expect(res.status).toBe(400);
  });
});
