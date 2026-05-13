import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import {
  chatMessage,
  chatMessageWorkflowLink,
  chatSession,
  indicatorStrategyScript,
  project,
  workflowRun,
  workspace,
} from "../db/sqlite/schema";

export const chatRouter = new Hono();

chatRouter.get("/health", async (c) => {
  const db = await getDb();
  try {
    await db.select().from(chatSession).limit(1);
    await db.select().from(chatMessage).limit(1);
    return c.json({ ok: true, tables: ["chat_session", "chat_message"] });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : "chat health failed" }, 500);
  }
});

chatRouter.get("/sessions", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  const projectId = c.req.query("projectId");
  if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);
  const db = await getDb();
  const whereClause = projectId
    ? and(eq(chatSession.workspaceId, workspaceId), eq(chatSession.projectId, projectId))
    : eq(chatSession.workspaceId, workspaceId);
  const rows = await db.select().from(chatSession).where(whereClause).orderBy(desc(chatSession.updatedAt));
  return c.json({ data: rows });
});

chatRouter.post("/sessions", async (c) => {
  const body = await c.req.json<{
    workspaceId: string;
    projectId?: string;
    title?: string;
    createdBy?: string;
  }>();
  const db = await getDb();
  const wsRows = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.id, body.workspaceId))
    .limit(1);
  if (!wsRows[0]) return c.json({ error: "workspace not found", workspaceId: body.workspaceId }, 404);
  if (body.projectId) {
    const projectRows = await db
      .select({ id: project.id, workspaceId: project.workspaceId })
      .from(project)
      .where(eq(project.id, body.projectId))
      .limit(1);
    if (!projectRows[0]) return c.json({ error: "project not found", projectId: body.projectId }, 404);
    if (projectRows[0].workspaceId !== body.workspaceId) {
      return c.json({ error: "project does not belong to workspace" }, 400);
    }
  }
  const id = crypto.randomUUID();
  await db.insert(chatSession).values({
    id,
    workspaceId: body.workspaceId,
    projectId: body.projectId,
    title: body.title?.trim() || "新会话",
    createdBy: body.createdBy ?? "user",
  });
  const created = await db.select().from(chatSession).where(eq(chatSession.id, id)).limit(1);
  return c.json({ data: created[0] }, 201);
});

const purposeEnum = ["research", "live_trading", "both"] as const;

async function assertWorkflowBelongsToSession(
  db: Awaited<ReturnType<typeof getDb>>,
  sessionId: string,
  workflowRunId: string | undefined | null
): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  if (!workflowRunId) return { ok: true };
  const wf = await db.select().from(workflowRun).where(eq(workflowRun.id, workflowRunId)).limit(1);
  if (!wf[0]) return { ok: false, status: 404, body: { error: "workflow run not found", workflowRunId } };
  if (wf[0].sessionId !== sessionId) {
    return { ok: false, status: 400, body: { error: "workflow run does not belong to this session", workflowRunId } };
  }
  return { ok: true };
}

chatRouter.get("/sessions/:sessionId/strategy-scripts", async (c) => {
  const sessionId = c.req.param("sessionId");
  const db = await getDb();
  const sessionRows = await db.select().from(chatSession).where(eq(chatSession.id, sessionId)).limit(1);
  if (!sessionRows[0]) return c.json({ error: "session not found", sessionId }, 404);
  const rows = await db
    .select()
    .from(indicatorStrategyScript)
    .where(eq(indicatorStrategyScript.sessionId, sessionId))
    .orderBy(desc(indicatorStrategyScript.updatedAt));
  return c.json({ data: rows });
});

chatRouter.post("/sessions/:sessionId/strategy-scripts", async (c) => {
  const sessionId = c.req.param("sessionId");
  const body = await c.req.json<{
    name?: string;
    ideCode?: string;
    signalCode?: string;
    workflowRunId?: string | null;
    aiPromptSnapshot?: string | null;
    chartSnapshotJson?: Record<string, unknown>;
    purpose?: (typeof purposeEnum)[number];
  }>();
  const db = await getDb();
  const sessionRows = await db.select().from(chatSession).where(eq(chatSession.id, sessionId)).limit(1);
  if (!sessionRows[0]) return c.json({ error: "session not found", sessionId }, 404);
  const name = String(body.name ?? "").trim();
  if (!name) return c.json({ error: "name is required" }, 400);
  const wfCheck = await assertWorkflowBelongsToSession(db, sessionId, body.workflowRunId ?? undefined);
  if (!wfCheck.ok) return c.json(wfCheck.body, wfCheck.status);
  const purpose = body.purpose && purposeEnum.includes(body.purpose) ? body.purpose : "both";
  const chartJson =
    body.chartSnapshotJson && typeof body.chartSnapshotJson === "object"
      ? JSON.stringify(body.chartSnapshotJson)
      : "{}";
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(indicatorStrategyScript).values({
    id,
    sessionId,
    workflowRunId: body.workflowRunId ?? null,
    name,
    ideCode: String(body.ideCode ?? ""),
    signalCode: String(body.signalCode ?? ""),
    aiPromptSnapshot: body.aiPromptSnapshot ?? null,
    chartSnapshotJson: chartJson,
    purpose,
    createdAt: now,
    updatedAt: now,
  });
  const created = await db.select().from(indicatorStrategyScript).where(eq(indicatorStrategyScript.id, id)).limit(1);
  return c.json({ data: created[0] }, 201);
});

chatRouter.patch("/strategy-scripts/:scriptId", async (c) => {
  const scriptId = c.req.param("scriptId");
  const body = await c.req.json<{
    name?: string;
    ideCode?: string;
    signalCode?: string;
    workflowRunId?: string | null;
    aiPromptSnapshot?: string | null;
    chartSnapshotJson?: Record<string, unknown>;
    purpose?: (typeof purposeEnum)[number];
  }>();
  const db = await getDb();
  const rows = await db.select().from(indicatorStrategyScript).where(eq(indicatorStrategyScript.id, scriptId)).limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "strategy script not found", scriptId }, 404);
  const wfCheck = await assertWorkflowBelongsToSession(
    db,
    row.sessionId,
    body.workflowRunId !== undefined ? body.workflowRunId : row.workflowRunId
  );
  if (!wfCheck.ok) return c.json(wfCheck.body, wfCheck.status);
  const purpose =
    body.purpose && purposeEnum.includes(body.purpose) ? body.purpose : row.purpose;
  const patch: Partial<typeof indicatorStrategyScript.$inferInsert> = {
    updatedAt: new Date().toISOString(),
    purpose,
  };
  if (body.name !== undefined) {
    const n = String(body.name).trim();
    patch.name = n || row.name;
  }
  if (body.ideCode !== undefined) patch.ideCode = String(body.ideCode);
  if (body.signalCode !== undefined) patch.signalCode = String(body.signalCode);
  if (body.workflowRunId !== undefined) patch.workflowRunId = body.workflowRunId;
  if (body.aiPromptSnapshot !== undefined) patch.aiPromptSnapshot = body.aiPromptSnapshot;
  if (body.chartSnapshotJson !== undefined && typeof body.chartSnapshotJson === "object") {
    patch.chartSnapshotJson = JSON.stringify(body.chartSnapshotJson);
  }
  await db.update(indicatorStrategyScript).set(patch).where(eq(indicatorStrategyScript.id, scriptId));
  const updated = await db.select().from(indicatorStrategyScript).where(eq(indicatorStrategyScript.id, scriptId)).limit(1);
  return c.json({ data: updated[0] });
});

chatRouter.delete("/strategy-scripts/:scriptId", async (c) => {
  const scriptId = c.req.param("scriptId");
  const db = await getDb();
  await db.delete(indicatorStrategyScript).where(eq(indicatorStrategyScript.id, scriptId));
  return c.json({ ok: true, deletedId: scriptId });
});

chatRouter.get("/sessions/:id/messages", async (c) => {
  const db = await getDb();
  const sessionId = c.req.param("id");
  const sessionRows = await db.select().from(chatSession).where(eq(chatSession.id, sessionId)).limit(1);
  if (!sessionRows[0]) return c.json({ error: "session not found", sessionId }, 404);
  const messages = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, sessionId))
    .orderBy(chatMessage.createdAt);
  const allLinks = await db.select().from(chatMessageWorkflowLink);
  const linkByMessage = new Map<string, string[]>();
  for (const link of allLinks) {
    const list = linkByMessage.get(link.chatMessageId) ?? [];
    list.push(link.workflowRunId);
    linkByMessage.set(link.chatMessageId, list);
  }
  return c.json({
    data: messages.map((item) => ({
      ...item,
      workflowRunIds: linkByMessage.get(item.id) ?? [],
    })),
  });
});

chatRouter.post("/sessions/:id/messages", async (c) => {
  const sessionId = c.req.param("id");
  const body = await c.req.json<{
    role: "user" | "assistant" | "system";
    sender?: "user" | "orchestrator" | "agent" | "system";
    content: string;
    status?: "queued" | "running" | "completed" | "failed";
    workflowRunIds?: string[];
  }>();
  const db = await getDb();
  const sessionRows = await db.select().from(chatSession).where(eq(chatSession.id, sessionId)).limit(1);
  if (!sessionRows[0]) return c.json({ error: "session not found", sessionId }, 404);
  const id = crypto.randomUUID();
  await db.insert(chatMessage).values({
    id,
    sessionId,
    role: body.role,
    sender: body.sender ?? (body.role === "user" ? "user" : "orchestrator"),
    content: body.content,
    status: body.status ?? "queued",
  });
  if (body.workflowRunIds?.length) {
    for (const workflowRunId of body.workflowRunIds) {
      const runRows = await db
        .select({ id: workflowRun.id })
        .from(workflowRun)
        .where(eq(workflowRun.id, workflowRunId))
        .limit(1);
      if (!runRows[0]) continue;
      const existing = await db
        .select()
        .from(chatMessageWorkflowLink)
        .where(
          and(
            eq(chatMessageWorkflowLink.chatMessageId, id),
            eq(chatMessageWorkflowLink.workflowRunId, workflowRunId)
          )
        )
        .limit(1);
      if (existing[0]) continue;
      await db.insert(chatMessageWorkflowLink).values({
        id: crypto.randomUUID(),
        chatMessageId: id,
        workflowRunId,
        traceId: crypto.randomUUID(),
      });
    }
  }
  await db
    .update(chatSession)
    .set({ lastActivityAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    .where(eq(chatSession.id, sessionId));
  const created = await db.select().from(chatMessage).where(eq(chatMessage.id, id)).limit(1);
  return c.json({ data: created[0] }, 201);
});

chatRouter.patch("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ title?: string; status?: "active" | "archived" }>();
  const db = await getDb();
  await db
    .update(chatSession)
    .set({
      title: body.title,
      status: body.status,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(chatSession.id, id));
  const rows = await db.select().from(chatSession).where(eq(chatSession.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: "Not found" }, 404);
  return c.json({ data: rows[0] });
});

chatRouter.patch("/messages/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    content?: string;
    status?: "queued" | "running" | "completed" | "failed";
    errorMessage?: string | null;
    workflowRunIds?: string[];
  }>();
  const db = await getDb();
  const messageRows = await db.select().from(chatMessage).where(eq(chatMessage.id, id)).limit(1);
  if (!messageRows[0]) return c.json({ error: "message not found", messageId: id }, 404);
  await db
    .update(chatMessage)
    .set({
      content: body.content ?? messageRows[0].content,
      status: body.status ?? messageRows[0].status,
      errorMessage:
        body.errorMessage === undefined ? messageRows[0].errorMessage : (body.errorMessage ?? null),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(chatMessage.id, id));
  if (body.workflowRunIds?.length) {
    for (const runId of body.workflowRunIds) {
      const existing = await db
        .select()
        .from(chatMessageWorkflowLink)
        .where(
          and(eq(chatMessageWorkflowLink.chatMessageId, id), eq(chatMessageWorkflowLink.workflowRunId, runId))
        )
        .limit(1);
      if (existing[0]) continue;
      await db.insert(chatMessageWorkflowLink).values({
        id: crypto.randomUUID(),
        chatMessageId: id,
        workflowRunId: runId,
        traceId: crypto.randomUUID(),
      });
    }
  }
  const updated = await db.select().from(chatMessage).where(eq(chatMessage.id, id)).limit(1);
  return c.json({ data: updated[0] });
});

chatRouter.get("/projects/:id/sessions/default", async (c) => {
  const db = await getDb();
  const projectId = c.req.param("id");
  const projectRows = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
  if (!projectRows[0]) return c.json({ error: "Project not found" }, 404);
  const sessionRows = await db
    .select()
    .from(chatSession)
    .where(eq(chatSession.projectId, projectId))
    .orderBy(desc(chatSession.lastActivityAt))
    .limit(1);
  if (sessionRows[0]) return c.json({ data: sessionRows[0] });
  const id = crypto.randomUUID();
  await db.insert(chatSession).values({
    id,
    workspaceId: projectRows[0].workspaceId,
    projectId,
    title: "默认会话",
    createdBy: "system",
  });
  const created = await db.select().from(chatSession).where(eq(chatSession.id, id)).limit(1);
  return c.json({ data: created[0] }, 201);
});
