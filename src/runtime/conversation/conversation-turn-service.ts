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
import { parseAgentPlanSnapshot } from "../agent-control-mode";
import { dispatchTaskToRole } from "../agent-pool";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import { clearWorkflowCheckpointForNewTurn } from "../workflow/checkpoint-turn";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";
import { publishTurnStarted } from "./client-event-bus";
import {
  completeWorkflowConversationAssistant,
  createConversationTurnMessages,
  createWorkflowConversationTurnMessages,
  linkConversationMessageToWorkflow,
} from "./conversation-projection";
import { registerTurnRunBinding } from "./turn-binding";
import {
  type ConversationTurnMode,
  resolveTurnMode,
} from "./turn-mode";

export interface CreateConversationTurnInput {
  sessionId: string;
  projectId: string;
  message: string;
  workflowRunId?: string;
  workflowMode?: "research" | "backtest" | "simulation" | "live";
  /** @deprecated 使用 turnMode；false → new_goal */
  reuseSessionWorkflow?: boolean;
  /** 显式 Turn 模式（06 协议） */
  turnMode?: ConversationTurnMode;
  loopKind?: AgentLoopKind;
  roleReasoner?: AgentLoopKind;
  hitlMode?: "off" | "ai" | "always";
  agentMode?: AgentControlMode;
  processConfig?: WorkflowProcessConfig;
  /** @deprecated 映射为 continue_goal */
  preserveGoal?: boolean;
}

export interface ConversationTurnResult {
  sessionId: string;
  /** 本轮用户消息 id（Turn 稳定身份） */
  turnId: string;
  /** primary Run = workflow_run.id */
  runId: string;
  /** @deprecated 与 runId 相同；保留兼容 */
  workflowRunId: string;
  /** orchestrator agent instance run（可选） */
  agentRunId?: string;
  turnMode: ConversationTurnMode;
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

function finalizeTurnResult(input: {
  sessionId: string;
  turnId: string;
  workflowRunId: string;
  turnMode: ConversationTurnMode;
  agentRunId?: string;
  userMessage: typeof chatMessage.$inferSelect;
  assistantMessage: typeof chatMessage.$inferSelect;
}): ConversationTurnResult {
  registerTurnRunBinding({
    sessionId: input.sessionId,
    turnId: input.turnId,
    workflowRunId: input.workflowRunId,
    ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
    turnMode: input.turnMode,
  });
  publishTurnStarted({
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.workflowRunId,
    turnMode: input.turnMode,
    ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
  });
  return {
    sessionId: input.sessionId,
    turnId: input.turnId,
    runId: input.workflowRunId,
    workflowRunId: input.workflowRunId,
    turnMode: input.turnMode,
    ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
    userMessage: input.userMessage,
    assistantMessage: input.assistantMessage,
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

  const turnMode = resolveTurnMode({
    turnMode: input.turnMode,
    reuseSessionWorkflow: input.reuseSessionWorkflow,
    preserveGoal: input.preserveGoal,
    hasWorkflowRunId: Boolean(input.workflowRunId),
  });

  if (!input.workflowRunId) {
    const turn = await createConversationTurnMessages({
      sessionId: input.sessionId,
      content: message,
    });
    const turnId = turn.userMessage.id;
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
      const reuseSessionWorkflow = turnMode === "continue_goal";
      const created = await createAndDispatchWorkflow({
        projectId: input.projectId,
        goal: message,
        mode: input.workflowMode ?? "research",
        sessionId: input.sessionId,
        source: "chat",
        messageId: turn.userMessage.id,
        reuseSessionWorkflow,
        loopKind: input.loopKind,
        loopOptionsJson: mergeLoopOptions(
          (latestChatWorkflow[0]?.loopOptionsJson as Record<string, unknown> | null) ?? {},
          input
        ),
      });
      await linkConversationMessageToWorkflow(turn.assistantMessage.id, created.data.id);
      // 每一轮用户发言都清 ReAct checkpoint，避免旧 final/observations 串台；
      // turnMode 只决定是否复用 primary Run / 是否保留 Goal plan。
      await clearWorkflowCheckpointForNewTurn(created.data.id);
      return finalizeTurnResult({
        sessionId: input.sessionId,
        turnId,
        workflowRunId: created.data.id,
        turnMode,
        ...(created.runId ? { agentRunId: created.runId } : {}),
        userMessage: turn.userMessage,
        assistantMessage: turn.assistantMessage,
      });
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
  const turnId = turn.userMessage.id;
  const loopOptionsJson = mergeLoopOptions(
    (workflow.loopOptionsJson as Record<string, unknown> | null) ?? {},
    input
  );
  const currentPlan = parseAgentPlanSnapshot(workflow.planJson);
  const promotePlanToGoal =
    input.agentMode === "goal" && currentPlan?.mode === "plan" && Boolean(currentPlan.steps.length);
  const continueExistingGoal =
    turnMode === "continue_goal" &&
    input.agentMode === "goal" &&
    currentPlan?.mode === "goal" &&
    Boolean(currentPlan.steps.length);
  const goalText =
    promotePlanToGoal || continueExistingGoal
      ? currentPlan?.goal?.text?.trim() || workflow.goal
      : message;
  const nextPlan =
    promotePlanToGoal || continueExistingGoal
      ? {
          ...currentPlan,
          mode: "goal" as const,
          goal: {
            ...currentPlan.goal,
            text: goalText,
            status: "executing" as const,
          },
          updatedAt: new Date().toISOString(),
        }
      : input.agentMode === "goal" || input.agentMode === "plan"
        ? null
        : workflow.planJson;
  await db
    .update(workflowRun)
    .set({
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      ...(input.agentMode === "goal" || input.agentMode === "plan" || turnMode === "new_goal"
        ? { goal: goalText }
        : {}),
      planJson: nextPlan as never,
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
  // 每轮用户发言清 ReAct checkpoint；Goal 文本/plan 由 turnMode + agentMode 保留。
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
          conversationTurnId: turn.assistantMessage.id,
          turnId,
          turnMode,
          sessionId: input.sessionId,
        },
      },
    });
    return finalizeTurnResult({
      sessionId: turn.sessionId,
      turnId,
      workflowRunId: workflow.id,
      turnMode,
      agentRunId: out.runId,
      userMessage: turn.userMessage,
      assistantMessage: turn.assistantMessage,
    });
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
