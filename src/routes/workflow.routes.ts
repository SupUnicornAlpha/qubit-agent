import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import { chatMessageWorkflowLink, workflowRun } from "../db/sqlite/schema";
import { eq } from "drizzle-orm";
import { dispatchTaskToRole } from "../runtime/agent-pool";

export const workflowRouter = new Hono();

workflowRouter.get("/", async (c) => {
  const db = await getDb();
  const rows = await db.select().from(workflowRun).limit(50);
  return c.json({ data: rows });
});

workflowRouter.post("/", async (c) => {
  const body = await c.req.json<{
    projectId: string;
    goal: string;
    mode: "research" | "backtest" | "simulation" | "live";
    sessionId?: string;
    source?: "chat" | "manual" | "api";
    messageId?: string;
  }>();

  const db = await getDb();
  const id = crypto.randomUUID();

  await db.insert(workflowRun).values({
    id,
    projectId: body.projectId,
    sessionId: body.sessionId,
    goal: body.goal,
    mode: body.mode,
    source: body.source ?? "manual",
    status: "pending",
  });

  // Kick off orchestration through runtime agent pool
  const { runId } = await dispatchTaskToRole({
    workflowId: id,
    role: "orchestrator",
    payload: {
      taskId: crypto.randomUUID(),
      taskType: "workflow_start",
      params: { workflowRunId: id, goal: body.goal, mode: body.mode },
      assignedRole: "orchestrator",
    },
  });

  const created = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, id))
    .limit(1);

  if (body.messageId) {
    await db.insert(chatMessageWorkflowLink).values({
      id: crypto.randomUUID(),
      chatMessageId: body.messageId,
      workflowRunId: id,
      traceId: crypto.randomUUID(),
    });
  }

  return c.json({ data: created[0], runId }, 201);
});

workflowRouter.get("/:id", async (c) => {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, c.req.param("id")))
    .limit(1);
  if (!rows[0]) return c.json({ error: "Not found" }, 404);
  return c.json({ data: rows[0] });
});
