import { Hono } from "hono";
import { dispatchTaskToRole } from "../agents";
import { getDb } from "../db/sqlite/client";
import {
  chatMessage,
  chatSession,
  communicationChannel,
  communicationMessageLog,
  chatMessageWorkflowLink,
  project,
  workflowRun,
  workspace,
} from "../db/sqlite/schema";
import { and, desc, eq } from "drizzle-orm";

const TELEGRAM_API = "https://api.telegram.org";

export const integrationsRouter = new Hono();

integrationsRouter.post("/telegram/send", async (c) => {
  const body = await c.req.json<{
    channelId?: string;
    chatId?: string;
    text: string;
  }>();
  const db = await getDb();
  let targetChatId = body.chatId;
  let token = process.env.QUBIT_TELEGRAM_BOT_TOKEN ?? "";
  if (body.channelId) {
    const rows = await db
      .select()
      .from(communicationChannel)
      .where(and(eq(communicationChannel.id, body.channelId), eq(communicationChannel.kind, "telegram")))
      .limit(1);
    if (!rows[0]) return c.json({ error: "telegram channel not found" }, 404);
    targetChatId = rows[0].externalChatId;
    token = (rows[0].secretRef || token).trim();
  }
  if (!token) return c.json({ error: "missing telegram token" }, 400);
  if (!targetChatId) return c.json({ error: "missing telegram chatId" }, 400);
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: targetChatId, text: body.text }),
  });
  const payload = await res.json();
  await db.insert(communicationMessageLog).values({
    id: crypto.randomUUID(),
    direction: "outbound",
    channelKind: "telegram",
    externalChatId: targetChatId,
    externalMessageId: String(payload?.result?.message_id ?? ""),
    payloadJson: payload,
    status: res.ok ? "success" : "failed",
    errorMessage: res.ok ? null : JSON.stringify(payload),
  });
  return c.json({ ok: res.ok, data: payload }, res.ok ? 200 : 502);
});

integrationsRouter.post("/telegram/webhook", async (c) => {
  const secret = c.req.header("x-telegram-bot-api-secret-token");
  if (process.env.QUBIT_TELEGRAM_WEBHOOK_SECRET && secret !== process.env.QUBIT_TELEGRAM_WEBHOOK_SECRET) {
    return c.json({ error: "invalid webhook secret" }, 401);
  }
  const body = await c.req.json<{
    update_id?: number;
    message?: {
      message_id?: number;
      text?: string;
      chat?: { id?: number };
      from?: { id?: number; username?: string };
    };
  }>();
  const text = body.message?.text?.trim();
  const chatId = body.message?.chat?.id ? String(body.message.chat.id) : "";
  if (!text || !chatId) return c.json({ ok: true, skipped: "no text message" });
  const db = await getDb();
  let channel = (
    await db
      .select()
      .from(communicationChannel)
      .where(and(eq(communicationChannel.kind, "telegram"), eq(communicationChannel.externalChatId, chatId)))
      .limit(1)
  )[0];
  if (!channel) {
    const workspaceRows = await db.select().from(workspace).orderBy(desc(workspace.createdAt)).limit(1);
    if (!workspaceRows[0]) return c.json({ error: "no workspace available" }, 400);
    const projectRows = await db
      .select()
      .from(project)
      .where(eq(project.workspaceId, workspaceRows[0].id))
      .orderBy(desc(project.createdAt))
      .limit(1);
    channel = {
      id: crypto.randomUUID(),
      workspaceId: workspaceRows[0].id,
      projectId: projectRows[0]?.id ?? null,
      kind: "telegram" as const,
      name: `telegram-${chatId}`,
      externalChatId: chatId,
      secretRef: process.env.QUBIT_TELEGRAM_BOT_TOKEN ?? "",
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.insert(communicationChannel).values(channel);
  }
  const projectId = channel.projectId ?? (
    await db.select().from(project).where(eq(project.workspaceId, channel.workspaceId)).limit(1)
  )[0]?.id;
  if (!projectId) return c.json({ error: "no project available for telegram channel" }, 400);
  let session = (
    await db
      .select()
      .from(chatSession)
      .where(and(eq(chatSession.workspaceId, channel.workspaceId), eq(chatSession.projectId, projectId)))
      .orderBy(desc(chatSession.lastActivityAt))
      .limit(1)
  )[0];
  if (!session) {
    session = {
      id: crypto.randomUUID(),
      workspaceId: channel.workspaceId,
      projectId,
      title: `Telegram ${chatId}`,
      status: "active",
      lastActivityAt: new Date().toISOString(),
      createdBy: "system",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await db.insert(chatSession).values(session);
  }
  const userMessageId = crypto.randomUUID();
  await db.insert(chatMessage).values({
    id: userMessageId,
    sessionId: session.id,
    role: "user",
    sender: "user",
    content: text,
    status: "running",
  });
  const workflowId = crypto.randomUUID();
  await db.insert(workflowRun).values({
    id: workflowId,
    projectId,
    sessionId: session.id,
    goal: text,
    mode: "research",
    source: "chat",
    status: "pending",
  });
  await db.insert(chatMessageWorkflowLink).values({
    id: crypto.randomUUID(),
    chatMessageId: userMessageId,
    workflowRunId: workflowId,
    traceId: crypto.randomUUID(),
  });
  await dispatchTaskToRole({
    workflowId,
    role: "orchestrator",
    payload: {
      taskId: crypto.randomUUID(),
      taskType: "workflow_start",
      params: { workflowRunId: workflowId, goal: text, mode: "research" },
      assignedRole: "orchestrator",
    },
  });
  await db.insert(communicationMessageLog).values({
    id: crypto.randomUUID(),
    direction: "inbound",
    channelKind: "telegram",
    externalChatId: chatId,
    externalMessageId: String(body.message?.message_id ?? ""),
    payloadJson: body,
    status: "success",
  });
  return c.json({ ok: true, data: { sessionId: session.id, workflowId, userMessageId } });
});
