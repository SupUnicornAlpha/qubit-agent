import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-session-wf-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const drizzle = await import("drizzle-orm");
const {
  consolidateAllChatSessionWorkflows,
  consolidateChatWorkflowsForSession,
  ensureChatSessionWorkflow,
  getCanonicalChatSessionWorkflowId,
} = await import("../session-workflow");

const WORKSPACE_ID = "ws-session-wf";
const PROJECT_ID = "proj-session-wf";
const SESSION_ID = "sess-session-wf";

async function seedSession(): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.workspace)
    .values({ id: WORKSPACE_ID, name: "session-wf-ws", owner: "test" })
    .onConflictDoNothing();
  await db
    .insert(schema.project)
    .values({
      id: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      name: "session-wf-proj",
      marketScope: "us",
    })
    .onConflictDoNothing();
  await db
    .insert(schema.chatSession)
    .values({
      id: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      title: "test session",
      createdBy: "test",
    })
    .onConflictDoNothing();
}

describe("session-workflow (1 session = 1 chat workflow)", () => {
  beforeAll(async () => {
    await runMigrations();
    await seedSession();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("consolidate keeps earliest chat workflow and cancels duplicates", async () => {
    const sessionId = "sess-consolidate-dup";
    const db = await getDb();
    await db.insert(schema.chatSession).values({
      id: sessionId,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      title: "consolidate test",
      createdBy: "test",
    });
    const keepId = "wf-chat-keep";
    const dupId = "wf-chat-dup";
    await db.insert(schema.workflowRun).values([
      {
        id: keepId,
        projectId: PROJECT_ID,
        sessionId,
        goal: "first",
        mode: "research",
        source: "chat",
        status: "completed",
        startedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: dupId,
        projectId: PROJECT_ID,
        sessionId,
        goal: "second",
        mode: "research",
        source: "chat",
        status: "running",
        startedAt: "2024-06-01T00:00:00.000Z",
      },
    ]);

    const canonical = await consolidateChatWorkflowsForSession(db, {
      projectId: PROJECT_ID,
      sessionId,
    });
    expect(canonical).toBe(keepId);

    const dupRow = await db
      .select()
      .from(schema.workflowRun)
      .where(drizzle.eq(schema.workflowRun.id, dupId))
      .limit(1);
    expect(dupRow[0]?.status).toBe("cancelled");
  });

  test("consolidateAllChatSessionWorkflows scans every session once", async () => {
    const sessionA = "sess-all-a";
    const sessionB = "sess-all-b";
    const db = await getDb();
    for (const id of [sessionA, sessionB]) {
      await db.insert(schema.chatSession).values({
        id,
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        title: id,
        createdBy: "test",
      });
    }
    await db.insert(schema.workflowRun).values([
      {
        id: "wf-all-a1",
        projectId: PROJECT_ID,
        sessionId: sessionA,
        goal: "a1",
        mode: "research",
        source: "chat",
        status: "completed",
        startedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "wf-all-a2",
        projectId: PROJECT_ID,
        sessionId: sessionA,
        goal: "a2",
        mode: "research",
        source: "chat",
        status: "running",
        startedAt: "2024-02-01T00:00:00.000Z",
      },
      {
        id: "wf-all-b1",
        projectId: PROJECT_ID,
        sessionId: sessionB,
        goal: "b1",
        mode: "research",
        source: "chat",
        status: "running",
        startedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const result = await consolidateAllChatSessionWorkflows();
    expect(result.sessionsScanned).toBeGreaterThanOrEqual(2);
    expect(result.duplicatesCancelled).toBeGreaterThanOrEqual(1);

    const canonicalA = await getCanonicalChatSessionWorkflowId({
      projectId: PROJECT_ID,
      sessionId: sessionA,
    });
    expect(canonicalA).toBe("wf-all-a1");
  });

  test("ensureChatSessionWorkflow is idempotent", async () => {
    const sessionId = "sess-ensure-idempotent";
    const db = await getDb();
    await db.insert(schema.chatSession).values({
      id: sessionId,
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
      title: "ensure test",
      createdBy: "test",
    });

    const first = await ensureChatSessionWorkflow({
      projectId: PROJECT_ID,
      sessionId,
      goal: "placeholder",
    });
    expect(first.created).toBe(true);

    const second = await ensureChatSessionWorkflow({
      projectId: PROJECT_ID,
      sessionId,
      goal: "should-not-create-dup",
    });
    expect(second.created).toBe(false);
    expect(second.workflowRunId).toBe(first.workflowRunId);

    const canonical = await getCanonicalChatSessionWorkflowId({
      projectId: PROJECT_ID,
      sessionId,
    });
    expect(canonical).toBe(first.workflowRunId);

    const chatRows = await db
      .select()
      .from(schema.workflowRun)
      .where(
        drizzle.and(
          drizzle.eq(schema.workflowRun.sessionId, sessionId),
          drizzle.eq(schema.workflowRun.source, "chat")
        )
      );
    const active = chatRows.filter((r) => r.status !== "cancelled");
    expect(active.length).toBe(1);
  });
});
