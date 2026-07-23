import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  chatMessage,
  chatMessageWorkflowLink,
  chatSession,
  workflowRun,
} from "../../db/sqlite/schema";
import type { AgentControlMode, AgentLoopKind, WorkflowProcessConfig } from "../../types/loop";
import { dispatchTaskToRole } from "../agent-pool";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import { clearWorkflowCheckpointForNewTurn } from "../workflow/checkpoint-turn";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";
import {
  completeWorkflowConversationAssistant,
  createConversationTurnMessages,
  createWorkflowConversationTurnMessages,
  linkConversationMessageToWorkflow,
} from "./conversation-projection";

export interface CreateConversationTurnInput {
  sessionId: string;
  projectId: string;
  message: string;
  workflowRunId?: string;
  workflowMode?: "research" | "backtest" | "simulation" | "live";
  reuseSessionWorkflow?: boolean;
  loopKind?: AgentLoopKind;
  roleReasoner?: AgentLoopKind;
  hitlMode?: "off" | "ai" | "always";
  agentMode?: AgentControlMode;
  processConfig?: WorkflowProcessConfig;
}

export interface ConversationTurnResult {
  sessionId: string;
  workflowRunId: string;
  runId?: string;
  userMessage: typeof chatMessage.$inferSelect;
  assistantMessage: typeof chatMessage.$inferSelect;
}

async function buildWorkflowConversationContext(
  workflowRunId: string,
  currentUserMessageId: string
): Promise<string> {
  const db = await getDb();
  const rows = await db
    .select({ message: chatMessage })
    .from(chatMessageWorkflowLink)
    .innerJoin(chatMessage, eq(chatMessage.id, chatMessageWorkflowLink.chatMessageId))
    .where(eq(chatMessageWorkflowLink.workflowRunId, workflowRunId))
    .orderBy(desc(chatMessage.createdAt))
    .limit(32);
  const transcript = rows
    .reverse()
    .map((row) => row.message)
    .filter(
      (message) =>
        message.id !== currentUserMessageId &&
        message.content.trim().length > 0 &&
        message.role !== "system"
    )
    .slice(-30)
    .map(
      (message) =>
        `- ${message.role === "user" ? "user" : message.sender}: ${message.content.slice(0, 800)}`
    )
    .join("\n");
  return transcript
    ? `## 统一会话上下文（最近消息，按时间）\n${transcript}`
    : "（本会话暂无历史对话）";
}

function mergeLoopOptions(
  current: Record<string, unknown>,
  input: CreateConversationTurnInput
): Record<string, unknown> {
  return {
    ...current,
    ...(input.hitlMode
      ? {
          hitlMode: input.hitlMode,
          hitlChatMode: input.hitlMode,
        }
      : {}),
    ...(input.roleReasoner ? { roleReasoner: input.roleReasoner } : {}),
    ...(input.agentMode ? { agentMode: input.agentMode } : {}),
    ...(input.processConfig ? { processConfig: input.processConfig } : {}),
  };
}

export async function createConversationTurn(
  input: CreateConversationTurnInput
): Promise<ConversationTurnResult> {
  const message = input.message.trim();
  if (!message) throw new Error("message is required");
  const db = await getDb();
  const sessions = await db
    .select()
    .from(chatSession)
    .where(eq(chatSession.id, input.sessionId))
    .limit(1);
  const session = sessions[0];
  if (!session) throw new Error(`session not found: ${input.sessionId}`);
  if (session.projectId && session.projectId !== input.projectId) {
    throw new Error("session does not belong to project");
  }

  if (!input.workflowRunId) {
    const turn = await createConversationTurnMessages({
      sessionId: input.sessionId,
      content: message,
    });
    try {
      const latestChatWorkflow = await db
        .select({ loopOptionsJson: workflowRun.loopOptionsJson })
        .from(workflowRun)
        .where(
          and(
            eq(workflowRun.projectId, input.projectId),
            eq(workflowRun.sessionId, input.sessionId),
            eq(workflowRun.source, "chat")
          )
        )
        .orderBy(desc(workflowRun.startedAt))
        .limit(1);
      const created = await createAndDispatchWorkflow({
        projectId: input.projectId,
        goal: message,
        mode: input.workflowMode ?? "research",
        sessionId: input.sessionId,
        source: "chat",
        messageId: turn.userMessage.id,
        reuseSessionWorkflow: input.reuseSessionWorkflow ?? true,
        loopKind: input.loopKind,
        loopOptionsJson: mergeLoopOptions(
          (latestChatWorkflow[0]?.loopOptionsJson as Record<string, unknown> | null) ?? {},
          input
        ),
      });
      await linkConversationMessageToWorkflow(turn.assistantMessage.id, created.data.id);
      return {
        sessionId: input.sessionId,
        workflowRunId: created.data.id,
        ...(created.runId ? { runId: created.runId } : {}),
        ...turn,
      };
    } catch (error) {
      await db
        .update(chatMessage)
        .set({
          content: `执行启动失败：${error instanceof Error ? error.message : String(error)}`,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(chatMessage.id, turn.assistantMessage.id));
      throw error;
    }
  }

  const workflows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, input.workflowRunId))
    .limit(1);
  const workflow = workflows[0];
  if (!workflow) throw new Error(`workflow not found: ${input.workflowRunId}`);
  if (workflow.projectId !== input.projectId)
    throw new Error("workflow does not belong to project");
  if (workflow.sessionId && workflow.sessionId !== input.sessionId) {
    throw new Error("workflow does not belong to session");
  }
  if (!workflow.sessionId) {
    await db
      .update(workflowRun)
      .set({ sessionId: input.sessionId })
      .where(eq(workflowRun.id, workflow.id));
  }

  const turn = await createWorkflowConversationTurnMessages({
    workflowRunId: workflow.id,
    content: message,
  });
  const loopOptionsJson = mergeLoopOptions(
    (workflow.loopOptionsJson as Record<string, unknown> | null) ?? {},
    input
  );
  await db
    .update(workflowRun)
    .set({
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      loopOptionsJson: loopOptionsJson as never,
    })
    .where(eq(workflowRun.id, workflow.id));

  await logResearchTeamInteraction({
    workflowRunId: workflow.id,
    fromRole: "user",
    toRole: "orchestrator",
    kind: "llm_message",
    contentText: message.slice(0, 4000),
  });
  const context = await buildWorkflowConversationContext(workflow.id, turn.userMessage.id);
  await clearWorkflowCheckpointForNewTurn(workflow.id);
  try {
    const out = await dispatchTaskToRole({
      workflowId: workflow.id,
      role: "orchestrator",
      payload: {
        taskId: randomUUID(),
        taskType: "orchestrator_chat",
        assignedRole: "orchestrator",
        params: {
          goal: message,
          context,
          // 同一 workflow 可以包含多轮 Orchestrator 对话。终答投影必须按轮次幂等，
          // 不能让第一轮答复阻止后续轮次写入右栏的 research_team_interaction。
          conversationTurnId: turn.assistantMessage.id,
        },
      },
    });
    return {
      sessionId: turn.sessionId,
      workflowRunId: workflow.id,
      runId: out.runId,
      userMessage: turn.userMessage,
      assistantMessage: turn.assistantMessage,
    };
  } catch (error) {
    await completeWorkflowConversationAssistant({
      workflowRunId: workflow.id,
      content: `执行启动失败：${error instanceof Error ? error.message : String(error)}`,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
