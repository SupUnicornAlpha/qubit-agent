import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import { chatSession, scheduledJob, scheduledJobRun, workflowRun } from "../db/sqlite/schema";
import {
  enqueueCompensationTask,
  listCompensationTasks,
  processCompensationQueue,
} from "../runtime/workflow/compensation-queue";
import { computeNextRunAt, workflowScheduler } from "../runtime/workflow/scheduler";
import { createAndDispatchWorkflow } from "../runtime/workflow/workflow-service";
import {
  listWorkflowArtifactSummary,
  readWorkflowReportArtifact,
  saveWorkflowReportArtifact,
} from "../runtime/strategy/strategy-script-files";
import type { AgentExecutionPath } from "../types/execution-path";
import type { AgentLoopKind, LoopOptionsJson } from "../types/loop";

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
    reuseSessionWorkflow?: boolean;
    /** 为 true 时仅创建/复用 workflow_run，不向 orchestrator 派发 */
    skipDispatch?: boolean;
    loopKind?: AgentLoopKind;
    loopOptionsJson?: LoopOptionsJson;
    executionPath?: AgentExecutionPath;
  }>();

  const created = await createAndDispatchWorkflow({
    projectId: body.projectId,
    goal: body.goal,
    mode: body.mode,
    sessionId: body.sessionId,
    source: body.source,
    messageId: body.messageId,
    reuseSessionWorkflow: body.reuseSessionWorkflow,
    skipDispatch: body.skipDispatch === true,
    loopKind: body.loopKind,
    loopOptionsJson: body.loopOptionsJson,
    executionPath: body.executionPath,
  });
  return c.json(created, 201);
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
  const data = await processCompensationQueue(
    body.limit ? Math.max(1, Math.min(50, body.limit)) : 10
  );
  return c.json({ ok: true, data });
});

workflowRouter.get("/scheduled-jobs", async (c) => {
  const db = await getDb();
  const projectId = c.req.query("projectId");
  const workspaceId = c.req.query("workspaceId");
  const rows = await db
    .select()
    .from(scheduledJob)
    .where(
      projectId
        ? eq(scheduledJob.projectId, projectId)
        : workspaceId
          ? eq(scheduledJob.workspaceId, workspaceId)
          : undefined
    )
    .orderBy(desc(scheduledJob.updatedAt));
  return c.json({ data: rows });
});

workflowRouter.post("/scheduled-jobs", async (c) => {
  const body = await c.req.json<{
    workspaceId?: string;
    projectId?: string;
    sessionId?: string | null;
    name?: string;
    cronExpr?: string;
    timezone?: string;
    payloadJson?: Record<string, unknown>;
    executionMode?: "paper" | "live_with_confirm" | "live_direct";
    enabled?: boolean;
    createdBy?: string;
  }>();
  if (!body.workspaceId || !body.projectId || !body.cronExpr) {
    return c.json({ error: "workspaceId, projectId and cronExpr are required" }, 400);
  }
  const db = await getDb();
  const id = randomUUID();
  const now = new Date();
  const nextRunAt = computeNextRunAt(body.cronExpr, now);
  await db.insert(scheduledJob).values({
    id,
    workspaceId: body.workspaceId,
    projectId: body.projectId,
    sessionId: body.sessionId ?? null,
    name: body.name?.trim() || `scheduled-${id.slice(0, 8)}`,
    enabled: body.enabled ?? true,
    cronExpr: body.cronExpr,
    timezone: body.timezone ?? "UTC",
    payloadJson: body.payloadJson ?? {},
    executionMode: body.executionMode ?? "paper",
    nextRunAt,
    createdBy: body.createdBy ?? "user",
  });
  const created = await db.select().from(scheduledJob).where(eq(scheduledJob.id, id)).limit(1);
  return c.json({ data: created[0] }, 201);
});

workflowRouter.patch("/scheduled-jobs/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    enabled?: boolean;
    cronExpr?: string;
    timezone?: string;
    payloadJson?: Record<string, unknown>;
    executionMode?: "paper" | "live_with_confirm" | "live_direct";
  }>();
  const db = await getDb();
  const existed = await db.select().from(scheduledJob).where(eq(scheduledJob.id, id)).limit(1);
  if (!existed[0]) return c.json({ error: "scheduled job not found" }, 404);
  const current = existed[0];
  const cronExpr = body.cronExpr ?? current.cronExpr;
  const nextRunAt = computeNextRunAt(cronExpr, new Date());
  await db
    .update(scheduledJob)
    .set({
      name: body.name ?? current.name,
      enabled: body.enabled ?? current.enabled,
      cronExpr,
      timezone: body.timezone ?? current.timezone,
      payloadJson: body.payloadJson ?? current.payloadJson,
      executionMode: body.executionMode ?? current.executionMode,
      nextRunAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(scheduledJob.id, id));
  const updated = await db.select().from(scheduledJob).where(eq(scheduledJob.id, id)).limit(1);
  return c.json({ data: updated[0] });
});

workflowRouter.post("/scheduled-jobs/:id/run-now", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const existed = await db.select().from(scheduledJob).where(eq(scheduledJob.id, id)).limit(1);
  if (!existed[0]) return c.json({ error: "scheduled job not found" }, 404);
  await db
    .update(scheduledJob)
    .set({ nextRunAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(scheduledJob.id, id));
  await workflowScheduler.tick();
  const runs = await db
    .select()
    .from(scheduledJobRun)
    .where(eq(scheduledJobRun.jobId, id))
    .orderBy(desc(scheduledJobRun.createdAt))
    .limit(1);
  return c.json({ ok: true, data: runs[0] ?? null });
});

workflowRouter.get("/scheduled-jobs/:id/runs", async (c) => {
  const id = c.req.param("id");
  const limit = Math.max(1, Math.min(200, Number(c.req.query("limit") ?? 50)));
  const db = await getDb();
  const runs = await db
    .select()
    .from(scheduledJobRun)
    .where(eq(scheduledJobRun.jobId, id))
    .orderBy(desc(scheduledJobRun.createdAt))
    .limit(limit);
  return c.json({ data: runs });
});

const workflowStatusEnum = ["pending", "running", "completed", "failed", "cancelled"] as const;

workflowRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{
      sessionId?: string | null;
      goal?: string;
      status?: (typeof workflowStatusEnum)[number];
    }>()
    .catch(() => ({}));
  const db = await getDb();
  const rows = await db.select().from(workflowRun).where(eq(workflowRun.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: "Not found" }, 404);
  const cur = rows[0];
  const patch: Partial<typeof workflowRun.$inferInsert> = {};
  if (body.goal !== undefined) {
    const g = String(body.goal).trim();
    if (g) patch.goal = g;
  }
  if (body.status !== undefined) {
    if (!workflowStatusEnum.includes(body.status)) {
      return c.json({ error: "invalid status", allowed: workflowStatusEnum }, 400);
    }
    patch.status = body.status;
    if (body.status === "completed" || body.status === "failed" || body.status === "cancelled") {
      patch.endedAt = new Date().toISOString();
    }
  }
  if (body.sessionId !== undefined) {
    if (body.sessionId) {
      const s = await db.select().from(chatSession).where(eq(chatSession.id, body.sessionId)).limit(1);
      if (!s[0]) return c.json({ error: "session not found", sessionId: body.sessionId }, 404);
    }
    patch.sessionId = body.sessionId;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ data: cur });
  }
  await db.update(workflowRun).set(patch).where(eq(workflowRun.id, id));
  const updated = await db.select().from(workflowRun).where(eq(workflowRun.id, id)).limit(1);
  return c.json({ data: updated[0] });
});

/** 软删除：将工作流标记为 cancelled（保留审计数据） */
workflowRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const rows = await db.select().from(workflowRun).where(eq(workflowRun.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: "Not found" }, 404);
  await db
    .update(workflowRun)
    .set({ status: "cancelled", endedAt: new Date().toISOString() })
    .where(eq(workflowRun.id, id));
  return c.json({ ok: true, id });
});

workflowRouter.get("/:id/artifacts", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const rows = await db.select().from(workflowRun).where(eq(workflowRun.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: "Not found" }, 404);
  const summary = await listWorkflowArtifactSummary(rows[0].projectId, id);
  const report = await readWorkflowReportArtifact(rows[0].projectId, id);
  return c.json({ data: { ...summary, report } });
});

workflowRouter.put("/:id/artifacts/report", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ report?: string; ticker?: string }>().catch(() => ({}));
  const report = typeof body.report === "string" ? body.report : "";
  if (!report.trim()) return c.json({ error: "report is required" }, 400);
  const db = await getDb();
  const rows = await db.select().from(workflowRun).where(eq(workflowRun.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: "Not found" }, 404);
  const reportPath = await saveWorkflowReportArtifact({
    projectId: rows[0].projectId,
    workflowRunId: id,
    report,
    ticker: typeof body.ticker === "string" ? body.ticker : undefined,
  });
  return c.json({ data: { reportPath } });
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
