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
import { clearWorkflowCancellation } from "../workflow/workflow-cancellation";
import {
  isResearchTeamPlaceholderTitle,
  summarizeResearchQuestionTitle,
} from "../workflow/workflow-title";
import { buildWorkspaceBootstrapPack, openWorkspaceById, writeRunRecord } from "../workspace";
import { publishTurnStarted } from "./client-event-bus";
import {
  completeWorkflowConversationAssistant,
  createWorkflowConversationTurnMessages,
} from "./conversation-projection";
import { ensureChatSessionWorkflow } from "./session-workflow";
import { type ChatImageAttachment, toCoreImageAttachments } from "./image-attachments";
import { registerTurnRunBinding } from "./turn-binding";
import { type ConversationTurnMode, resolveTurnMode } from "./turn-mode";
import {
  buildContextIsolationState,
  buildGoalTopicResetNotice,
  buildKnowledgeIntentGuard,
  detectGoalTopicShift,
  parseContextIsolation,
} from "./goal-scope";
import {
  type RecentToolLine,
  buildSessionChronicle,
  emptyRollingChronicle,
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
  /** 场景评测等内部调用的附加 workflow 选项；执行仍必须走本函数的对话 turn。 */
  loopOptionsJson?: Record<string, unknown>;
  /** 可选研究场景标签，用于 artifact gate 与审计，不改变对话入口。 */
  researchScenarioId?: string;
  /** Browser-pasted images, validated by the chat route before persistence. */
  attachments?: ChatImageAttachment[];
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
  const isolation = parseContextIsolation(loopOptions.contextIsolation);
  const sections: string[] = [];
  if (isolation) {
    sections.push(buildGoalTopicResetNotice(isolation));
  }
  const knowledgeGuard = buildKnowledgeIntentGuard(currentUserText);
  if (knowledgeGuard) sections.push(knowledgeGuard);
  const chronicle = buildSessionChronicle({
    messages,
    currentUserMessageId,
    currentUserText,
    recentTools,
    maxMessages: 8,
    priorCompactedSummary: rolled.priorCompactedSummary,
  });
  sections.push(chronicle);
  return { context: sections.filter(Boolean).join("\n\n"), rollingChronicle: rolled.state };
}

function buildFreshLoopOptionsForTopicShift(input: {
  priorGoal: string;
  reason: string;
  merge: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    ...input.merge,
    sessionChronicle: emptyRollingChronicle(),
    contextIsolation: buildContextIsolationState({
      reason: input.reason,
      priorGoal: input.priorGoal,
    }),
  };
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
    ...(input.loopOptionsJson ?? {}),
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
  const message = input.message.trim() || (input.attachments?.length ? "请分析附图。" : "");
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

  const { workflowRunId: canonicalWorkflowId } = await ensureChatSessionWorkflow({
    projectId: input.projectId,
    sessionId: input.sessionId,
    goal: message.slice(0, 120),
    mode: input.workflowMode ?? "research",
    loopOptionsJson: mergeLoopOptions({}, input),
  });

  if (input.workflowRunId && input.workflowRunId !== canonicalWorkflowId) {
    console.warn(
      `[conversation-turn] Ignoring workflowRunId=${input.workflowRunId}; session canonical=${canonicalWorkflowId}`
    );
  }

  const workflows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, canonicalWorkflowId))
    .limit(1);
  const workflow = workflows[0];
  if (!workflow) throw new Error(`workflow not found: ${canonicalWorkflowId}`);
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
    attachments: input.attachments,
  });
  const turnId = turn.userMessage.id;
  clearWorkflowCancellation(workflow.id);
  let loopOptionsJson = mergeLoopOptions(
    (workflow.loopOptionsJson as Record<string, unknown> | null) ?? {},
    input
  );
  const explicitNewGoal = turnMode === "new_goal";
  const inlineShift = detectGoalTopicShift(workflow.goal, message);
  if (explicitNewGoal || inlineShift.shifted) {
    loopOptionsJson = buildFreshLoopOptionsForTopicShift({
      priorGoal: workflow.goal,
      reason: inlineShift.shifted
        ? (inlineShift.reason ?? "goal_topic_shift")
        : "turn_mode_new_goal",
      merge: loopOptionsJson,
    });
  }
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
  /**
   * 研究团队「新建工作流」先生成范围/时间占位标题；首条真实用户问题到来时，
   * 用短摘要替换它。只命中占位格式，后续追问与用户自行命名的工作流均不会被改名。
   */
  const questionDerivedTitle = isResearchTeamPlaceholderTitle(workflow.goal)
    ? summarizeResearchQuestionTitle(message)
    : null;
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
      ...(questionDerivedTitle
        ? { goal: questionDerivedTitle }
        : input.agentMode === "goal" || input.agentMode === "plan" || turnMode === "new_goal"
          ? { goal: goalText }
          : {}),
      planJson: nextPlan as never,
      loopOptionsJson: loopOptionsJson as never,
      ...(input.researchScenarioId
        ? { researchScenarioId: input.researchScenarioId }
        : {}),
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
      const isolated = Boolean(parseContextIsolation(loopOptionsJson.contextIsolation));
      const pack = await buildWorkspaceBootstrapPack(fsWorkspaceId, {
        maxInstructionChars: 1600,
        maxMemoryChars: isolated ? 240 : 800,
        omitExecutionMemory: isolated,
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
          ...(input.attachments?.length
            ? { attachments: toCoreImageAttachments(input.attachments) }
            : {}),
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
