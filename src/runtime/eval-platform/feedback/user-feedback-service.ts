import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import {
  chatMessage,
  chatMessageWorkflowLink,
  chatSession,
  workflowRun,
} from "../../../db/sqlite/schema";
import { booleanScore, textScore } from "../score-value";
import { insertScores } from "../score-writer";

export async function submitChatMessageFeedback(input: {
  chatMessageId: string;
  helpful: boolean;
  comment?: string;
  actor?: string;
}) {
  const db = await getDb();
  const msgRows = await db
    .select({
      id: chatMessage.id,
      sessionId: chatMessage.sessionId,
      role: chatMessage.role,
    })
    .from(chatMessage)
    .where(eq(chatMessage.id, input.chatMessageId))
    .limit(1);
  const msg = msgRows[0];
  if (!msg) throw new Error(`chat_message_not_found:${input.chatMessageId}`);
  if (msg.role !== "assistant") {
    throw new Error("feedback_only_allowed_on_assistant_messages");
  }

  const links = await db
    .select({ workflowRunId: chatMessageWorkflowLink.workflowRunId })
    .from(chatMessageWorkflowLink)
    .where(eq(chatMessageWorkflowLink.chatMessageId, input.chatMessageId))
    .limit(1);
  const workflowRunId = links[0]?.workflowRunId;
  if (!workflowRunId) {
    throw new Error("chat_message_has_no_linked_workflow");
  }

  const sessionRow = await db
    .select({ projectId: chatSession.projectId })
    .from(chatSession)
    .where(eq(chatSession.id, msg.sessionId))
    .limit(1);

  const wfRow = await db
    .select({ sessionId: workflowRun.sessionId })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);

  const drafts = [
    {
      name: "user.feedback.helpful",
      ...booleanScore(input.helpful),
      comment: input.comment,
      source: "human" as const,
      evaluatorId: "user.chat_feedback",
      observationId: `${workflowRunId}:chat:${input.chatMessageId}`,
      sessionId: wfRow[0]?.sessionId ?? msg.sessionId,
    },
    {
      name: "user.feedback.label",
      ...textScore(input.helpful ? "helpful" : "not_helpful"),
      source: "human" as const,
      evaluatorId: "user.chat_feedback",
      observationId: `${workflowRunId}:chat:${input.chatMessageId}`,
      sessionId: wfRow[0]?.sessionId ?? msg.sessionId,
    },
  ];

  const written = await insertScores(workflowRunId, drafts, wfRow[0]?.sessionId ?? msg.sessionId);
  return {
    written,
    workflowRunId,
    chatMessageId: input.chatMessageId,
    projectId: sessionRow[0]?.projectId ?? null,
  };
}

export async function submitWorkflowFeedback(input: {
  workflowRunId: string;
  helpful: boolean;
  comment?: string;
  actor?: string;
}) {
  const db = await getDb();
  const wf = await db
    .select({ sessionId: workflowRun.sessionId })
    .from(workflowRun)
    .where(eq(workflowRun.id, input.workflowRunId))
    .limit(1);
  if (!wf[0]) throw new Error(`workflow_not_found:${input.workflowRunId}`);

  const drafts = [
    {
      name: "user.feedback.helpful",
      ...booleanScore(input.helpful),
      ...(input.comment ? { comment: input.comment } : {}),
      source: "human" as const,
      evaluatorId: input.actor ?? "user.workflow_feedback",
      sessionId: wf[0].sessionId ?? undefined,
    },
  ];
  const written = await insertScores(input.workflowRunId, drafts, wf[0].sessionId);
  return { written };
}
