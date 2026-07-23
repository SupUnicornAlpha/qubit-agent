import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  chatMessage,
  chatMessageWorkflowLink,
  chatSession,
  project,
  workflowRun,
} from "../../db/sqlite/schema";

export type ConversationMessageStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "awaiting_approval";

export async function ensureWorkflowConversation(workflowRunId: string): Promise<{
  sessionId: string;
  projectId: string;
}> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  const workflow = rows[0];
  if (!workflow) throw new Error(`workflow not found: ${workflowRunId}`);
  if (workflow.sessionId) {
    return { sessionId: workflow.sessionId, projectId: workflow.projectId };
  }

  const projects = await db
    .select({ workspaceId: project.workspaceId })
    .from(project)
    .where(eq(project.id, workflow.projectId))
    .limit(1);
  const workspaceId = projects[0]?.workspaceId;
  if (!workspaceId) throw new Error(`project not found: ${workflow.projectId}`);

  const sessionId = randomUUID();
  const titleBase = workflow.goal.trim() || "Workflow 会话";
  await db.insert(chatSession).values({
    id: sessionId,
    workspaceId,
    projectId: workflow.projectId,
    title: titleBase.length > 48 ? `${titleBase.slice(0, 48)}…` : titleBase,
    createdBy: "system",
  });
  await db.update(workflowRun).set({ sessionId }).where(eq(workflowRun.id, workflowRunId));
  return { sessionId, projectId: workflow.projectId };
}

export async function linkConversationMessageToWorkflow(
  messageId: string,
  workflowRunId: string
): Promise<void> {
  const db = await getDb();
  const existing = await db
    .select({ id: chatMessageWorkflowLink.id })
    .from(chatMessageWorkflowLink)
    .where(
      and(
        eq(chatMessageWorkflowLink.chatMessageId, messageId),
        eq(chatMessageWorkflowLink.workflowRunId, workflowRunId)
      )
    )
    .limit(1);
  if (existing[0]) return;
  await db.insert(chatMessageWorkflowLink).values({
    id: randomUUID(),
    chatMessageId: messageId,
    workflowRunId,
    traceId: randomUUID(),
  });
}

async function touchSession(sessionId: string): Promise<void> {
  const db = await getDb();
  const now = new Date().toISOString();
  await db
    .update(chatSession)
    .set({ lastActivityAt: now, updatedAt: now })
    .where(eq(chatSession.id, sessionId));
}

async function nextMessageTimestamp(sessionId: string): Promise<string> {
  const db = await getDb();
  const latest = await db
    .select({ createdAt: chatMessage.createdAt })
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, sessionId))
    .orderBy(desc(chatMessage.createdAt))
    .limit(1);
  const latestMs = latest[0]?.createdAt ? new Date(latest[0].createdAt).getTime() : 0;
  return new Date(Math.max(Date.now(), latestMs + 1)).toISOString();
}

export async function createWorkflowConversationTurnMessages(input: {
  workflowRunId: string;
  content: string;
}): Promise<{
  sessionId: string;
  userMessage: typeof chatMessage.$inferSelect;
  assistantMessage: typeof chatMessage.$inferSelect;
}> {
  const { sessionId } = await ensureWorkflowConversation(input.workflowRunId);
  const created = await createConversationTurnMessages({
    sessionId,
    content: input.content,
  });
  await linkConversationMessageToWorkflow(created.userMessage.id, input.workflowRunId);
  await linkConversationMessageToWorkflow(created.assistantMessage.id, input.workflowRunId);
  return { sessionId, ...created };
}

export async function createConversationTurnMessages(input: {
  sessionId: string;
  content: string;
}): Promise<{
  userMessage: typeof chatMessage.$inferSelect;
  assistantMessage: typeof chatMessage.$inferSelect;
}> {
  const db = await getDb();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const userCreatedAt = await nextMessageTimestamp(input.sessionId);
  const assistantCreatedAt = new Date(new Date(userCreatedAt).getTime() + 1).toISOString();
  await db.insert(chatMessage).values([
    {
      id: userMessageId,
      sessionId: input.sessionId,
      role: "user",
      sender: "user",
      content: input.content,
      status: "completed",
      createdAt: userCreatedAt,
      updatedAt: userCreatedAt,
    },
    {
      id: assistantMessageId,
      sessionId: input.sessionId,
      role: "assistant",
      sender: "orchestrator",
      content: "",
      status: "running",
      createdAt: assistantCreatedAt,
      updatedAt: assistantCreatedAt,
    },
  ]);
  await touchSession(input.sessionId);
  const created = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.sessionId, input.sessionId));
  const userMessage = created.find((row) => row.id === userMessageId);
  const assistantMessage = created.find((row) => row.id === assistantMessageId);
  if (!userMessage || !assistantMessage) {
    throw new Error("conversation turn messages were not persisted");
  }
  return {
    userMessage,
    assistantMessage,
  };
}

/** 固定团队启动等非 composer 入口也投影进统一会话。 */
export async function projectWorkflowUserMessage(input: {
  workflowRunId: string;
  content: string;
}): Promise<typeof chatMessage.$inferSelect | null> {
  const content = input.content.trim();
  if (!content) return null;
  const db = await getDb();
  const { sessionId } = await ensureWorkflowConversation(input.workflowRunId);
  const id = randomUUID();
  const createdAt = await nextMessageTimestamp(sessionId);
  await db.insert(chatMessage).values({
    id,
    sessionId,
    role: "user",
    sender: "user",
    content,
    status: "completed",
    createdAt,
    updatedAt: createdAt,
  });
  await linkConversationMessageToWorkflow(id, input.workflowRunId);
  await touchSession(sessionId);
  const rows = await db.select().from(chatMessage).where(eq(chatMessage.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function completeWorkflowConversationAssistant(input: {
  workflowRunId: string;
  content: string;
  status?: Extract<ConversationMessageStatus, "completed" | "failed">;
  errorMessage?: string | null;
}): Promise<typeof chatMessage.$inferSelect | null> {
  const content = input.content.trim();
  if (!content) return null;
  const db = await getDb();
  const { sessionId } = await ensureWorkflowConversation(input.workflowRunId);
  const latest = await db
    .select({ message: chatMessage })
    .from(chatMessageWorkflowLink)
    .innerJoin(chatMessage, eq(chatMessage.id, chatMessageWorkflowLink.chatMessageId))
    .where(
      and(
        eq(chatMessageWorkflowLink.workflowRunId, input.workflowRunId),
        eq(chatMessage.role, "assistant")
      )
    )
    .orderBy(desc(chatMessage.createdAt))
    .limit(1);
  const row = latest[0]?.message;
  if (row && (row.status === "running" || row.status === "queued")) {
    await db
      .update(chatMessage)
      .set({
        content,
        status: input.status ?? "completed",
        errorMessage: input.errorMessage ?? null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(chatMessage.id, row.id));
    await touchSession(sessionId);
    const updated = await db.select().from(chatMessage).where(eq(chatMessage.id, row.id)).limit(1);
    return updated[0] ?? null;
  }
  if (row?.content.trim() === content && row.status === (input.status ?? "completed")) return row;

  const id = randomUUID();
  const createdAt = await nextMessageTimestamp(sessionId);
  await db.insert(chatMessage).values({
    id,
    sessionId,
    role: "assistant",
    sender: "orchestrator",
    content,
    status: input.status ?? "completed",
    errorMessage: input.errorMessage ?? null,
    createdAt,
    updatedAt: createdAt,
  });
  await linkConversationMessageToWorkflow(id, input.workflowRunId);
  await touchSession(sessionId);
  const created = await db.select().from(chatMessage).where(eq(chatMessage.id, id)).limit(1);
  return created[0] ?? null;
}
