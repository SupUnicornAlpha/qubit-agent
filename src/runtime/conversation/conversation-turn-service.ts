import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  chatMessage,
  chatMessageWorkflowLink,
  chatSession,
  researchTeamInteraction,
  workflowRun,
} from "../../db/sqlite/schema";
import type { AgentControlMode, AgentLoopKind, WorkflowProcessConfig } from "../../types/loop";
import { parseAgentPlanSnapshot } from "../agent-control-mode";
import { dispatchTaskToRole } from "../agent-pool";
import { logResearchTeamInteraction } from "../research-team/interaction-log";
import { clearWorkflowCheckpointForNewTurn } from "../workflow/checkpoint-turn";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";
import { buildWorkspaceBootstrapPack, openWorkspaceById, writeRunRecord } from "../workspace";
import { publishTurnStarted } from "./client-event-bus";
import {
  completeWorkflowConversationAssistant,
  createConversationTurnMessages,
  createWorkflowConversationTurnMessages,
  linkConversationMessageToWorkflow,
} from "./conversation-projection";
import { registerTurnRunBinding } from "./turn-binding";
import { type ConversationTurnMode, resolveTurnMode } from "./turn-mode";
import {
  type RecentToolLine,
  buildSessionChronicle,
  inferToolStatus,
  mergeWorkspaceBackground,
  parseRollingChronicle,
  rollChronicleWindow,
} from "./turn-packet";

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
  /** FS Workspace id：注入说明书/记忆/宇宙到 Orchestrator context */
  fsWorkspaceId?: string;
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

async function loadRecentToolLines(workflowRunId: string): Promise<RecentToolLine[]> {
  const db = await getDb();
  const rows = await db
    .select({
      toolName: researchTeamInteraction.toolName,
      contentText: researchTeamInteraction.contentText,
      payloadJson: researchTeamInteraction.payloadJson,
    })
    .from(researchTeamInteraction)
    .where(
      and(
        eq(researchTeamInteraction.workflowRunId, workflowRunId),
        eq(researchTeamInteraction.kind, "tool_call")
      )
    )
    .orderBy(desc(researchTeamInteraction.createdAt))
    .limit(12);

  return rows
    .map((row) => {
      const name = (row.toolName ?? "").trim();
      if (!name) return null;
      const payload =
        row.payloadJson && typeof row.payloadJson === "object" && !Array.isArray(row.payloadJson)
          ? (row.payloadJson as Record<string, unknown>)
          : undefined;
      const status = inferToolStatus(row.contentText ?? "", payload);
      const detail = (row.contentText ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      return {
        toolName: name,
        status,
        ...(detail ? { detail } : {}),
      } satisfies RecentToolLine;
    })
    .filter((x): x is RecentToolLine => Boolean(x))
    .reverse();
}

/**
 * Host Turn Packet → params.context.
 * Full transcript stays in chat_* / UI; Core only sees compressed chronicle.
 * Returns chronicle text + updated rolling state for loop_options persistence.
 */
export async function buildWorkflowConversationContext(
  workflowRunId: string,
  currentUserMessageId: string,
  currentUserText: string,
  loopOptions: Record<string, unknown>
): Promise<{ context: string; rollingChronicle: ReturnType<typeof parseRollingChronicle> }> {
  const db = await getDb();
  const rows = await db
    .select({ message: chatMessage })
    .from(chatMessageWorkflowLink)
    .innerJoin(chatMessage, eq(chatMessage.id, chatMessageWorkflowLink.chatMessageId))
    .where(eq(chatMessageWorkflowLink.workflowRunId, workflowRunId))
    .orderBy(desc(chatMessage.createdAt))
    .limit(48);
  const messages = rows
    .reverse()
    .map((row) => row.message)
    .map((m) => ({
      id: m.id,
      role: m.role,
      sender: m.sender,
      content: m.content,
    }));
  const rolled = rollChronicleWindow({
    state: parseRollingChronicle(loopOptions.sessionChronicle),
    messages,
    currentUserMessageId,
    maxEntries: 8,
  });
  const recentTools = await loadRecentToolLines(workflowRunId);
  const context = buildSessionChronicle({
    messages,
    currentUserMessageId,
    currentUserText,
    recentTools,
    maxMessages: 8,
    priorCompactedSummary: rolled.priorCompactedSummary,
  });
  return { context, rollingChronicle: rolled.state };
}

/** Resume handoff: last user chat + compressed chronicle (not workflow.goal alone). */
export async function loadWorkflowResumeHandoff(workflowRunId: string): Promise<{
  lastUserPrompt: string | null;
  lastUserMessageId: string | null;
  sessionChronicle: string | null;
  loopOptions: Record<string, unknown>;
}> {
  const db = await getDb();
  const wfRows = await db
    .select({ loopOptionsJson: workflowRun.loopOptionsJson })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  const loopOptions = (wfRows[0]?.loopOptionsJson as Record<string, unknown> | null) ?? {};
  const persisted =
    typeof loopOptions.lastUserPrompt === "string" && loopOptions.lastUserPrompt.trim()
      ? loopOptions.lastUserPrompt.trim()
      : null;

  const rows = await db
    .select({ message: chatMessage })
    .from(chatMessageWorkflowLink)
    .innerJoin(chatMessage, eq(chatMessage.id, chatMessageWorkflowLink.chatMessageId))
    .where(
      and(eq(chatMessageWorkflowLink.workflowRunId, workflowRunId), eq(chatMessage.role, "user"))
    )
    .orderBy(desc(chatMessage.createdAt))
    .limit(1);
  const last = rows[0]?.message;
  const lastUserPrompt = (last?.content?.trim() ? last.content.trim() : null) ?? persisted;
  const lastUserMessageId = last?.id ?? null;

  let sessionChronicle: string | null = null;
  if (lastUserPrompt) {
    const built = await buildWorkflowConversationContext(
      workflowRunId,
      lastUserMessageId ?? `resume-${workflowRunId}`,
      lastUserPrompt,
      loopOptions
    );
    sessionChronicle = built.context.trim() || null;
  }

  return {
    lastUserPrompt,
    lastUserMessageId,
    sessionChronicle,
    loopOptions,
  };
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
    ...(input.fsWorkspaceId?.trim() ? { fsWorkspaceId: input.fsWorkspaceId.trim() } : {}),
  };
}

/** Soft process-wide default so bridge/pipe loaders see the active FS workspace. */
function activateFsWorkspaceEnv(fsWorkspaceId: string | undefined): void {
  const id = fsWorkspaceId?.trim();
  if (id) process.env.QUBIT_ACTIVE_FS_WORKSPACE_ID = id;
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
  activateFsWorkspaceEnv(input.fsWorkspaceId);

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
  let loopOptionsJson = mergeLoopOptions(
    (workflow.loopOptionsJson as Record<string, unknown> | null) ?? {},
    input
  );
  const built = await buildWorkflowConversationContext(
    workflow.id,
    turn.userMessage.id,
    message,
    loopOptionsJson
  );
  let context = built.context;
  loopOptionsJson = {
    ...loopOptionsJson,
    sessionChronicle: built.rollingChronicle,
    /** Persist every chat utterance so resume can replay after timeout/partial. */
    lastUserPrompt: message,
    lastUserPromptAt: new Date().toISOString(),
  };
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
  const fsWorkspaceId = input.fsWorkspaceId?.trim();
  if (fsWorkspaceId) {
    try {
      // Keep workspace pack short — long AGENTS.md must not drown CURRENT_USER_TASK.
      const pack = await buildWorkspaceBootstrapPack(fsWorkspaceId, {
        maxInstructionChars: 1600,
        maxMemoryChars: 800,
      });
      context = mergeWorkspaceBackground(context, pack.contextBlock, 2200);
      const { fs, manifest } = await openWorkspaceById(fsWorkspaceId);
      await writeRunRecord(fs, {
        id: workflow.id,
        title: workflow.goal || message.slice(0, 80),
        status: "running",
        workflowId: workflow.id,
        sessionId: input.sessionId,
        focus: manifest.defaultFocus,
      });
    } catch (err) {
      console.warn(
        `[workspace] bootstrap failed for ${fsWorkspaceId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
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
