import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { getDb } from "../../db/sqlite/client";
import { agentInstance, agentStep, workflowRun } from "../../db/sqlite/schema";
import type { TaskAssignPayload } from "../../types/a2a";
import { parseLoopOptionsJson } from "../../types/loop";
import { parseAgentPlanSnapshot } from "../agent-control-mode";
import { resolveLlmForAgent } from "../llm/llm-router";
import { loadWorkflowTokenBudgetStatus } from "../llm/workflow-token-budget";
import { writeLlmCallLog } from "../monitor/llm-call-logger";
import { sandboxExecutor } from "../sandbox-executor";
import { stripToolCallSentinels } from "../tools/tool-call-format";
import type { RuntimeAgentDefinition } from "../types";
import { HitlAwaitingApprovalError } from "../workflow/hitl-service";
import { drainUserMessages } from "../workflow/user-message-queue";
import {
  WorkflowCancelledError,
  getWorkflowCancellationSignal,
  isWorkflowCancellationRequested,
} from "../workflow/workflow-cancellation";
import { writeCheckpointSnapshot } from "./agent-checkpoint-snapshot";
import {
  didTurnMakeProgress,
  nextUnproductiveTurnCount,
  shouldStopForUnproductiveTurns,
} from "./iteration-budget-policy";
import { loadIterationContext } from "./iteration-context";
import { extractFinalizeAnswerText, finalizeLoopState } from "./loop-finalization";
import {
  type TaskProgressEvent,
  isTaskDeadlineExpired,
  reportTaskProgress,
  terminateAtTaskDeadline,
  terminateByTaskCancellation,
  terminateByUser,
} from "./loop-lifecycle";
import { actNode } from "./nodes/act";
import { hitlGateNode } from "./nodes/hitl-gate";
import { observeNode } from "./nodes/observe";
import { perceiveNode } from "./nodes/perceive";
import { reasonNode } from "./nodes/reason";
import { shouldStopReactLoopAfterObserve } from "./react-loop-policy";
import type { AgentGraphState, StepStreamEvent } from "./state";

type Db = Awaited<ReturnType<typeof getDb>>;
const DEFAULT_REASON_NODE_TIMEOUT_MS = 180_000;

function reasonNodeTimeoutMs(): number {
  const raw = process.env.QUBIT_REASON_NODE_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_REASON_NODE_TIMEOUT_MS;
}

function parseProviderModel(llmProvider: string | null | undefined): {
  provider: string;
  model: string;
} {
  const raw = llmProvider?.trim();
  if (!raw) return { provider: "unknown", model: "unknown" };
  const [provider, ...modelParts] = raw.split(":");
  return {
    provider: provider || "unknown",
    model: modelParts.join(":") || "unknown",
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 自研 ReAct 循环：纯 `while` 状态机（perceive → reason → hitl_gate → act → observe）。
 *
 * 设计原则：
 *  - 节点序：perceive(fresh) → while{ reason → hitl_gate → act → observe → 决策 } → finalize
 *  - 6 个 node 是 `src/runtime/react/nodes/*` 的纯函数；本文件负责编排
 *    + 副作用（insertAgentStep / writeLlmCallLog / checkIterationLimit / snapshot）
 *  - 分支：
 *      hitl_gate 后 awaiting_approval/terminated → 跳出循环走 finalize
 *      act 后 awaiting_approval/terminated → 跳出循环走 finalize（HITL pause 在 act
 *        内被 catch 转 finalResponse）
 *      observe 后 5 分支：finalResponse / !forceReactLoop / shouldStop /
 *        iteration>=max / 否则回 reason
 *  - artifact gate push-back：observe 不写 finalResponse → shouldStop=false →
 *    iteration<max → 回 reason 重跑。
 *
 * 不负责：workflow_run.status / agent_instance 终态写 / final 帧 emit / resume —
 * 这些仍由 caller(executeAgentReact) 的统一出口处理（保留 P0-C 收敛）。
 */

export interface RunReactLoopParams {
  db: Db;
  runId: string;
  workflowId: string;
  traceId: string;
  def: RuntimeAgentDefinition;
  payload: TaskAssignPayload;
  agentInstanceId: string;
  forceReactLoop: boolean;
  /** 初始状态（fresh perceive 入口）。 */
  initialState: AgentGraphState;
  /** A topology child can be cancelled without cancelling its parent workflow. */
  isTaskCancellationRequested?: () => boolean;
  /**
   * A2A lease heartbeat / phase signal for topology children.
   * Fail-soft: callers must not let progress errors abort the ReAct loop.
   */
  onTaskProgress?: (event: TaskProgressEvent) => void | Promise<void>;
  /**
   * 自研 resume 入口（阶段 2）：传入则**跳过 perceive**，直接用此 state 进入 while
   * 循环（从下一轮 reason 重入）。来自 `restoreStateFromSnapshot`。
   *
   * 为什么跳 perceive：perceive 只读 inbound message + memory 建初始 context，
   * resume 时这些已在快照里（contextMemory/observations 全量还原），重跑 perceive
   * 反而会重复写 step0 并可能覆盖恢复的 context。
   */
  resumeFromState?: AgentGraphState;
  emit: (event: StepStreamEvent) => void;
}

export interface RunReactLoopResult {
  state: AgentGraphState;
}

/** 把原 StateGraph 每个 node 退出时的旁路 snapshot 复刻成本地 helper。 */
function snapshotState(
  params: RunReactLoopParams,
  phase: string,
  stepIndex: number,
  mergedState: AgentGraphState
): void {
  void writeCheckpointSnapshot({
    runId: params.runId,
    workflowId: params.workflowId,
    traceId: params.traceId,
    agentInstanceId: params.agentInstanceId,
    stepIndex,
    phase,
    state: mergedState,
  });
}

type LoopBudget = {
  maxIterations: number;
  maxConsecutiveUnproductiveTurns?: number;
};

async function resolveLoopBudget(params: RunReactLoopParams): Promise<LoopBudget> {
  try {
    const rows = await params.db
      .select({ loopOptionsJson: workflowRun.loopOptionsJson })
      .from(workflowRun)
      .where(eq(workflowRun.id, params.workflowId))
      .limit(1);
    const parsed = parseLoopOptionsJson(rows[0]?.loopOptionsJson) as Record<string, unknown>;
    const loopMax = Number(parsed.maxIterations);
    return {
      maxIterations:
        Number.isFinite(loopMax) && loopMax > 0 ? Math.floor(loopMax) : params.def.maxIterations,
      ...(typeof parsed.maxConsecutiveUnproductiveTurns === "number"
        ? { maxConsecutiveUnproductiveTurns: parsed.maxConsecutiveUnproductiveTurns }
        : {}),
    };
  } catch {
    // fall through to agent definition default
  }
  return { maxIterations: params.def.maxIterations };
}

async function loadGoalControlState(
  params: RunReactLoopParams
): Promise<"paused" | "cleared" | null> {
  const rows = await params.db
    .select({ planJson: workflowRun.planJson })
    .from(workflowRun)
    .where(eq(workflowRun.id, params.workflowId))
    .limit(1);
  const status = parseAgentPlanSnapshot(rows[0]?.planJson)?.goal?.status;
  return status === "paused" || status === "cleared" ? status : null;
}

/** perceive 节点：写 step0 + perceiveNode + snapshot。 */
async function runPerceive(
  params: RunReactLoopParams,
  state: AgentGraphState
): Promise<AgentGraphState> {
  const { db, agentInstanceId } = params;
  const perceiveStepId = randomUUID();
  await db.insert(agentStep).values({
    id: perceiveStepId,
    agentInstanceId,
    workflowRunId: params.workflowId,
    stepIndex: 0,
    phase: "perceive",
    thought: "Read inbound message and memory context",
    actionType: "memory_read",
    actionJson: { payload: params.payload },
  });
  const partial = await perceiveNode(state);
  const merged = { ...state, ...partial };
  snapshotState(params, "perceive", 0, merged);
  return merged;
}

/**
 * reason 节点：iteration+1 → 沙箱迭代限流 → 写 reason step → reasonNode →
 * 回写 token/latency → writeLlmCallLog → snapshot。
 * 返回 null 表示被沙箱迭代限流收口（state 已写 finalResponse=partial）。
 */
async function runReason(
  params: RunReactLoopParams,
  state: AgentGraphState
): Promise<AgentGraphState> {
  const { db, agentInstanceId, emit } = params;
  const nextIteration = state.iteration + 1;
  const tokenBudget = await loadWorkflowTokenBudgetStatus(db, params.workflowId);
  if (tokenBudget.hardLimitReached) {
    emit({
      runId: params.runId,
      workflowId: params.workflowId,
      traceId: params.traceId,
      role: params.def.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: {
        code: "WORKFLOW_TOKEN_BUDGET_EXHAUSTED",
        usedTokens: tokenBudget.usedTokens,
        maxTotalTokens: tokenBudget.policy.maxTotalTokens,
        message: "工作流 Token 预算已耗尽，已停止新的模型调用。",
      },
    });
    const blocked = {
      ...state,
      finalResponse: {
        status: "partial",
        reason: "token_budget_exhausted",
        usedTokens: tokenBudget.usedTokens,
        maxTotalTokens: tokenBudget.policy.maxTotalTokens,
        iteration: state.iteration,
      },
    };
    snapshotState(params, "reason", state.iteration, blocked);
    return blocked;
  }
  const iterationCheck = await sandboxExecutor.checkIterationLimit({
    runId: params.runId,
    workflowId: params.workflowId,
    traceId: params.traceId,
    agentInstanceId,
    definition: params.def,
    currentIteration: nextIteration,
  });
  if (!iterationCheck.allowed) {
    emit({
      runId: params.runId,
      workflowId: params.workflowId,
      traceId: params.traceId,
      role: params.def.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: {
        code: "SANDBOX_ITERATION_LIMIT",
        alertType: "iteration_exceeded",
        message: iterationCheck.reason ?? "iteration blocked by sandbox",
      },
    });
    const blocked = {
      ...state,
      finalResponse: {
        status: "partial",
        reason: "sandbox_iteration_limit",
        iteration: state.iteration,
      },
    };
    snapshotState(params, "reason", state.iteration, blocked);
    return blocked;
  }
  await db
    .update(agentInstance)
    .set({ currentIteration: nextIteration })
    .where(eq(agentInstance.id, agentInstanceId));
  const reasonStepId = randomUUID();
  const llmIdentity = await resolveLlmForAgent(params.def)
    .then((resolved) => ({
      provider: resolved.config.provider,
      model: resolved.config.model,
      source: resolved.source,
    }))
    .catch(() => {
      const parsed = parseProviderModel(params.def.llmProvider);
      return { ...parsed, source: "unresolved" };
    });
  await db.insert(agentStep).values({
    id: reasonStepId,
    agentInstanceId,
    workflowRunId: params.workflowId,
    stepIndex: nextIteration,
    phase: "reason",
    thought: "Reasoning with LLM provider",
    actionType: "tool_call",
    actionJson: {
      llmProvider: params.def.llmProvider,
      resolvedProvider: llmIdentity.provider,
      resolvedModel: llmIdentity.model,
      resolvedSource: llmIdentity.source,
    },
  });
  const reasonStartedAt = Date.now();
  let reasonResult: Awaited<ReturnType<typeof reasonNode>>;
  try {
    reasonResult = await withTimeout(
      reasonNode({ ...state, iteration: nextIteration }, emit),
      reasonNodeTimeoutMs(),
      `reason node timed out after ${reasonNodeTimeoutMs()}ms`
    );
  } catch (err) {
    if (
      err instanceof WorkflowCancelledError ||
      isWorkflowCancellationRequested(params.workflowId)
    ) {
      const cancelled = terminateByUser(state);
      snapshotState(params, "reason", state.iteration, cancelled);
      return cancelled;
    }
    const errorMessage = err instanceof Error ? err.message : String(err);
    const latencyMs = Date.now() - reasonStartedAt;
    const displayThought = `LLM reasoning failed: ${errorMessage}`;
    await db
      .update(agentStep)
      .set({
        thought: displayThought.slice(0, 12000),
        latencyMs,
      })
      .where(eq(agentStep.id, reasonStepId));
    await writeLlmCallLog({
      workflowRunId: params.workflowId,
      agentStepId: reasonStepId,
      agentDefinitionId: params.def.id,
      provider: llmIdentity.provider,
      model: llmIdentity.model,
      latencyMs,
      status: errorMessage.includes("timed out") ? "timeout" : "error",
      errorMessage: errorMessage.slice(0, 500),
      extraMeta: {
        iteration: nextIteration,
        agentRole: params.def.role,
        reasonNodeTimeoutMs: reasonNodeTimeoutMs(),
      },
    });
    emit({
      runId: params.runId,
      workflowId: params.workflowId,
      traceId: params.traceId,
      role: params.def.role,
      type: "error",
      stepIndex: nextIteration,
      ts: Date.now(),
      payload: {
        code: "REASON_NODE_FAILED",
        message: errorMessage,
      },
    });
    const failed = {
      ...state,
      iteration: nextIteration,
      finalResponse: {
        status: errorMessage.includes("timed out") ? "partial" : "terminated",
        reason: errorMessage.includes("timed out") ? "reason_timeout" : "reason_error",
        error: errorMessage,
        iteration: nextIteration,
      },
    };
    snapshotState(params, "reason", nextIteration, failed);
    return failed;
  }
  const usage = reasonResult.meta.usage;
  const tokenCount =
    usage?.totalTokens ?? (usage ? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) : 0);
  const reasonText = (reasonResult.stateUpdate.reasonText ?? "").trim();
  const displayThought = stripToolCallSentinels(reasonText);
  try {
    await db
      .update(agentStep)
      .set({
        thought:
          displayThought.length > 0
            ? displayThought.slice(0, 12000)
            : "Reasoning with LLM provider",
        tokenCount: tokenCount > 0 ? tokenCount : null,
        latencyMs: reasonResult.meta.latencyMs,
      })
      .where(eq(agentStep.id, reasonStepId));
  } catch (err) {
    console.warn(
      `[reason] failed to persist token/latency for step ${reasonStepId}:`,
      err instanceof Error ? err.message : String(err)
    );
  }
  if (reasonResult.meta.provider && reasonResult.meta.model) {
    await writeLlmCallLog({
      workflowRunId: params.workflowId,
      agentStepId: reasonStepId,
      agentDefinitionId: params.def.id,
      provider: reasonResult.meta.provider,
      model: reasonResult.meta.model,
      ...(reasonResult.meta.usage ? { usage: reasonResult.meta.usage } : {}),
      latencyMs: reasonResult.meta.latencyMs,
      status: reasonResult.meta.llmStatus ?? "success",
      ...(reasonResult.meta.errorMessage ? { errorMessage: reasonResult.meta.errorMessage } : {}),
      ...(reasonResult.meta.systemPromptLen !== undefined
        ? { systemPromptLen: reasonResult.meta.systemPromptLen }
        : {}),
      ...(reasonResult.meta.userPromptLen !== undefined
        ? { userPromptLen: reasonResult.meta.userPromptLen }
        : {}),
      ...(reasonResult.meta.firstTokenLatencyMs !== undefined
        ? { firstTokenLatencyMs: reasonResult.meta.firstTokenLatencyMs }
        : {}),
      ...(reasonResult.meta.finishReason ? { finishReason: reasonResult.meta.finishReason } : {}),
      ...(reasonResult.meta.responseId ? { responseId: reasonResult.meta.responseId } : {}),
      extraMeta: {
        fallbackUsed: reasonResult.meta.fallbackUsed,
        ...(reasonResult.meta.parseRetryUsed ? { parseRetryUsed: true } : {}),
        ...(reasonResult.meta.lengthRetryUsed ? { lengthRetryUsed: true } : {}),
        ...(reasonResult.meta.nativeToolCallingUsed ? { nativeToolCallingUsed: true } : {}),
        ...(reasonResult.meta.tokenBudgetSoftLimitReached
          ? { tokenBudgetSoftLimitReached: true }
          : {}),
        ...(reasonResult.meta.promptComponentChars
          ? { promptComponentChars: reasonResult.meta.promptComponentChars }
          : {}),
        ...(reasonResult.meta.promptEstimatedTokens !== undefined
          ? { promptEstimatedTokens: reasonResult.meta.promptEstimatedTokens }
          : {}),
        ...(reasonResult.meta.promptCompacted ? { promptCompacted: true } : {}),
        workflowTokenBudgetUsedBeforeCall: tokenBudget.usedTokens,
        workflowTokenBudgetMax: tokenBudget.policy.maxTotalTokens,
        iteration: nextIteration,
        agentRole: params.def.role,
      },
    });
  }
  const merged = { ...state, iteration: nextIteration, ...reasonResult.stateUpdate };
  snapshotState(params, "reason", nextIteration, merged);
  return merged;
}

/** hitl_gate 节点：hitlGateNode + snapshot。 */
async function runHitlGate(
  params: RunReactLoopParams,
  state: AgentGraphState
): Promise<AgentGraphState> {
  const partial = await hitlGateNode(state, params.emit, params.agentInstanceId);
  const merged = { ...state, ...partial };
  snapshotState(params, "hitl_gate", state.iteration, merged);
  return merged;
}

/**
 * act 节点：写 act step → actNode（捕获 HitlAwaitingApprovalError 转 finalResponse）→ snapshot。
 * finalResponse 已存在则跳过（与原 StateGraph act node 的 early-return 一致）。
 */
async function runAct(
  params: RunReactLoopParams,
  state: AgentGraphState
): Promise<AgentGraphState> {
  if (state.finalResponse) return state;
  const { db, agentInstanceId } = params;
  const actStepId = randomUUID();
  await db.insert(agentStep).values({
    id: actStepId,
    agentInstanceId,
    workflowRunId: params.workflowId,
    stepIndex: state.iteration,
    phase: "act",
    thought: "Execute selected tool",
    actionType: "tool_call",
    actionJson: { plannedAction: state.plannedAction },
  });
  try {
    const partial = await actNode(state, params.emit, agentInstanceId, actStepId);
    const merged = { ...state, ...partial };
    snapshotState(params, "act", state.iteration, merged);
    return merged;
  } catch (err) {
    if (err instanceof HitlAwaitingApprovalError) {
      const awaiting = {
        status: "awaiting_approval",
        hitlRequestId: err.requestId,
        title: err.message,
        iteration: state.iteration,
        role: params.def.role,
      };
      const merged = { ...state, finalResponse: awaiting };
      snapshotState(params, "act", state.iteration, merged);
      return merged;
    }
    throw err;
  }
}

/** observe 节点：observeNode + snapshot。 */
async function runObserve(
  params: RunReactLoopParams,
  state: AgentGraphState
): Promise<AgentGraphState> {
  const partial = await observeNode(state, params.emit, params.agentInstanceId);
  const merged = { ...state, ...partial };
  snapshotState(params, "observe", state.iteration, merged);
  return merged;
}

/**
 * 从最后一轮 reason / observation 中提取可面向用户展示的文本。
 *
 * ReAct 可能在工具调用完成后刚好耗尽最大迭代。此时历史实现只返回
 * `{ reason: "max_iterations" }`，导致 Orchestrator 明明已经有一版分析正文，
 * 用户侧却只能看到工具轨迹。这里剥离 tool sentinel，并依次回退到最近 observation。
 */
export { extractFinalizeAnswerText } from "./loop-finalization";

/** finalize 节点：补 finalResponse（completed / max_iterations partial）+ snapshot。 */
function runFinalize(params: RunReactLoopParams, state: AgentGraphState): AgentGraphState {
  return finalizeLoopState(
    {
      runId: params.runId,
      workflowId: params.workflowId,
      traceId: params.traceId,
      def: params.def,
      forceReactLoop: params.forceReactLoop,
      emit: params.emit,
      snapshot: (phase, stepIndex, merged) => snapshotState(params, phase, stepIndex, merged),
    },
    state
  );
}

async function attachIterationContext(
  params: RunReactLoopParams,
  state: AgentGraphState
): Promise<AgentGraphState> {
  try {
    const iterationContext = await loadIterationContext({
      db: params.db,
      workflowId: params.workflowId,
      definition: params.def,
      state,
    });
    return {
      ...state,
      iterationContext,
      scenarioSnapshot: iterationContext.snapshot,
    };
  } catch {
    return {
      ...state,
      iterationContext: state.iterationContext ?? null,
      scenarioSnapshot: state.scenarioSnapshot ?? null,
    };
  }
}

/** @deprecated kept for tests that may still patch — prefer evaluateWorkflowDelivery */
function isScenarioContractSatisfied(workflowId: string): boolean {
  void workflowId;
  return false;
}

void isScenarioContractSatisfied;

/** finalResponse.status 是否为终态（awaiting_approval / partial / terminated），与原条件边一致。 */
function isTerminalStatus(state: AgentGraphState): boolean {
  const st = state.finalResponse?.status;
  return st === "awaiting_approval" || st === "partial" || st === "terminated";
}

export { isTaskDeadlineExpired } from "./loop-lifecycle";

/**
 * 跑完整条 ReAct 循环并返回 finalize 后的 state。
 *
 * 抛出行为与原 StateGraph 一致：act 内非 HITL 异常会向上抛（caller 统一出口兜底）。
 */
export async function runReactLoop(params: RunReactLoopParams): Promise<RunReactLoopResult> {
  // 捕获“本次执行”自己的 signal。workflow id 被下一轮复用并 clear 后，旧 signal 仍保持
  // aborted，避免上一轮工具调用晚结束后死灰复燃。
  const cancellationSignal = getWorkflowCancellationSignal(params.workflowId);
  const loopBudget = await resolveLoopBudget(params);
  const effectiveMaxIterations = loopBudget.maxIterations;
  const effectiveParams =
    effectiveMaxIterations === params.def.maxIterations
      ? params
      : {
          ...params,
          def: { ...params.def, maxIterations: effectiveMaxIterations },
        };
  // resume：跳过 perceive，直接用恢复的 state 从下一轮 reason 重入；
  // fresh：先跑 perceive 建初始 context。
  let state =
    effectiveParams.resumeFromState ??
    (await runPerceive(effectiveParams, effectiveParams.initialState));

  // resume 时若恢复的 state 已是终态（如上一轮停在 finalize 才崩），直接 finalize 收口，
  // 不应再多跑一轮 reason。
  if (effectiveParams.resumeFromState && state.finalResponse) {
    return { state: runFinalize(effectiveParams, state) };
  }

  // while 主体对应原 conditionalEdges：reason→hitl_gate→act→observe→（回 reason / finalize）
  for (;;) {
    if (effectiveParams.isTaskCancellationRequested?.()) {
      state = terminateByTaskCancellation(state);
      break;
    }
    if (cancellationSignal.aborted || isWorkflowCancellationRequested(effectiveParams.workflowId)) {
      state = terminateByUser(state);
      break;
    }
    if (isTaskDeadlineExpired(effectiveParams.payload)) {
      state = terminateAtTaskDeadline(state);
      break;
    }
    const goalControlState = await loadGoalControlState(effectiveParams);
    if (goalControlState) {
      state = {
        ...state,
        finalResponse: {
          status: goalControlState === "paused" ? "awaiting_approval" : "completed",
          reason: goalControlState === "paused" ? "goal_paused" : "goal_cleared",
          answerText:
            goalControlState === "paused"
              ? "Goal 已按用户要求暂停；恢复后会从当前计划继续。"
              : "Goal 已由用户清除，当前执行已停止。",
          iteration: state.iteration,
          role: effectiveParams.def.role,
        },
      };
      break;
    }
    // 运行中「随时插话」：drain 本工作流面向本角色的注入消息，累加进 contextMemory，
    // 供本轮及后续 reason 拼进 LLM 上下文（软注入，不打断循环；失败 fail-soft）。
    try {
      const injected = await drainUserMessages(
        effectiveParams.workflowId,
        effectiveParams.def.role
      );
      if (injected.length > 0) {
        const prev = Array.isArray(state.contextMemory.injectedUserMessages)
          ? (state.contextMemory.injectedUserMessages as string[])
          : [];
        state = {
          ...state,
          contextMemory: {
            ...state.contextMemory,
            injectedUserMessages: [...prev, ...injected],
          },
        };
      }
    } catch (e) {
      console.warn(`[run-react-loop] drainUserMessages failed: ${(e as Error).message}`);
    }

    // One Snapshot per iteration for reason/act/finalize consumers.
    state = await attachIterationContext(effectiveParams, state);

    const beforeAct = state;
    await reportTaskProgress(effectiveParams.onTaskProgress, {
      phase: "reason",
      iteration: state.iteration,
    });
    state = await runReason(effectiveParams, state);
    // 沙箱迭代限流：reason 已写 terminated finalResponse → 直接 finalize
    if (isTerminalStatus(state)) break;
    if (effectiveParams.isTaskCancellationRequested?.()) {
      state = terminateByTaskCancellation(state);
      break;
    }

    state = await runHitlGate(effectiveParams, state);
    if (isTerminalStatus(state)) break;
    if (effectiveParams.isTaskCancellationRequested?.()) {
      state = terminateByTaskCancellation(state);
      break;
    }

    await reportTaskProgress(effectiveParams.onTaskProgress, {
      phase: "act",
      iteration: state.iteration,
    });
    state = await runAct(effectiveParams, state);
    if (isTerminalStatus(state)) break;
    if (effectiveParams.isTaskCancellationRequested?.()) {
      state = terminateByTaskCancellation(state);
      break;
    }

    await reportTaskProgress(effectiveParams.onTaskProgress, {
      phase: "observe",
      iteration: state.iteration,
    });
    state = await runObserve(effectiveParams, state);
    const consecutiveUnproductiveTurns = nextUnproductiveTurnCount({
      previous: state.consecutiveUnproductiveTurns,
      madeProgress: didTurnMakeProgress({ beforeAct, afterObserve: state }),
    });
    state = { ...state, consecutiveUnproductiveTurns };
    if (
      shouldStopForUnproductiveTurns({
        consecutiveUnproductiveTurns,
        ...(loopBudget.maxConsecutiveUnproductiveTurns !== undefined
          ? { maxConsecutiveUnproductiveTurns: loopBudget.maxConsecutiveUnproductiveTurns }
          : {}),
      })
    ) {
      const answerText = extractFinalizeAnswerText(state);
      effectiveParams.emit({
        runId: effectiveParams.runId,
        workflowId: effectiveParams.workflowId,
        traceId: effectiveParams.traceId,
        role: effectiveParams.def.role,
        type: "observe",
        stepIndex: state.iteration,
        ts: Date.now(),
        payload: {
          code: "UNPRODUCTIVE_TURN_BUDGET_EXHAUSTED",
          consecutiveUnproductiveTurns,
          maxConsecutiveUnproductiveTurns: loopBudget.maxConsecutiveUnproductiveTurns ?? 3,
          message: "连续回合没有产生新的成功工具证据，已停止自动重试并保留当前结果。",
        },
      });
      state = {
        ...state,
        finalResponse: {
          status: "partial",
          reason: "unproductive_turn_budget_exhausted",
          iteration: state.iteration,
          role: effectiveParams.def.role,
          answerText:
            answerText ||
            "本次执行连续未产生新的有效证据，已停止自动重试。请补充参数、调整目标或开始下一轮会话。",
        },
      };
      break;
    }
    // observe 后 5 分支（对应原 :430-442）
    if (state.finalResponse) break;
    if (!effectiveParams.forceReactLoop) break;
    if (shouldStopReactLoopAfterObserve(state)) break;
    if (state.iteration >= effectiveParams.def.maxIterations) break;
    // 否则回 reason 继续下一轮
  }

  // Refresh snapshot once more before finalize so DeliveryVerdict sees latest writes.
  state = await attachIterationContext(effectiveParams, state);
  state = runFinalize(effectiveParams, state);
  return { state };
}
