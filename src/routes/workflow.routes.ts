import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import { chatMessageWorkflowLink, workflowRun } from "../db/sqlite/schema";
import { eq } from "drizzle-orm";
import { dispatchTaskToRole } from "../runtime/agent-pool";
import {
  enqueueCompensationTask,
  listCompensationTasks,
  processCompensationQueue,
} from "../runtime/workflow/compensation-queue";

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

workflowRouter.post("/compensation/enqueue", async (c) => {
  const body = await c.req.json<{
    workflowRunId?: string;
    actionType?: "retry_from_start" | "resume" | "manual_intervention";
    reason?: string;
    payloadJson?: Record<string, unknown>;
    maxRetries?: number;
  }>();
  if (!body.workflowRunId) return c.json({ ok: false, error: "workflowRunId is required" }, 400);
  const data = await enqueueCompensationTask({
    workflowRunId: body.workflowRunId,
    actionType: body.actionType,
    reason: body.reason,
    payloadJson: body.payloadJson,
    maxRetries: body.maxRetries,
  });
  return c.json({ ok: true, data });
});

workflowRouter.get("/compensation/tasks", async (c) => {
  const status = c.req.query("status");
  const workflowRunId = c.req.query("workflowRunId");
  const limit = Number(c.req.query("limit") ?? 100);
  const data = await listCompensationTasks({
    status: status || undefined,
    workflowRunId: workflowRunId || undefined,
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100,
  });
  return c.json({ ok: true, data });
});

workflowRouter.post("/compensation/process", async (c) => {
  const body = await c.req.json<{ limit?: number }>().catch(() => ({}));
  const data = await processCompensationQueue(body.limit ? Math.max(1, Math.min(50, body.limit)) : 10);
  return c.json({ ok: true, data });
});
