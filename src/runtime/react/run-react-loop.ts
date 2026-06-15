import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { getDb } from "../../db/sqlite/client";
import { agentInstance, agentStep } from "../../db/sqlite/schema";
import { writeCheckpointSnapshot } from "../langgraph/agent-checkpoint-snapshot";
import { writeLlmCallLog } from "../monitor/llm-call-logger";
import { actNode } from "../langgraph/nodes/act";
import { hitlGateNode } from "../langgraph/nodes/hitl-gate";
import { observeNode } from "../langgraph/nodes/observe";
import { perceiveNode } from "../langgraph/nodes/perceive";
import { reasonNode } from "../langgraph/nodes/reason";
import {
  resolveForceReactLoop,
  shouldStopReactLoopAfterObserve,
} from "../langgraph/react-loop-policy";
import type { AgentGraphState, StepStreamEvent } from "../langgraph/state";
import { sandboxExecutor } from "../sandbox-executor";
import { stripToolCallSentinels } from "../tools/tool-call-format";
import { HitlAwaitingApprovalError } from "../workflow/hitl-service";
import { drainUserMessages } from "../workflow/user-message-queue";
import type { RuntimeAgentDefinition } from "../types";
import type { TaskAssignPayload } from "../../types/a2a";

type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * 自研 ReAct 循环：用纯 `while` 取代退化的单 channel LangGraph StateGraph。
 *
 * 设计原则（迁移自 execute-agent-react.ts 的 StateGraph 拓扑，行为等价）：
 *  - 节点序：perceive(fresh) → while{ reason → hitl_gate → act → observe → 决策 } → finalize
 *  - 6 个 node 仍是 `src/runtime/langgraph/nodes/*` 的纯函数，未改动；本文件只负责编排
 *    + 把原 StateGraph node 闭包里的副作用（insertAgentStep / writeLlmCallLog /
 *    checkIterationLimit / snapshot）原样搬过来，顺序与原实现逐行对齐。
 *  - 分支映射（对应原 execute-agent-react.ts:412-442 的 conditionalEdges）：
 *      hitl_gate 后 awaiting_approval/terminated → 跳出循环走 finalize
 *      act 后 awaiting_approval/terminated → 跳出循环走 finalize（HITL pause 在 act
 *        内被 catch 转 finalResponse）
 *      observe 后 5 分支：finalResponse / !forceReactLoop / shouldStop /
 *        iteration>=max / 否则回 reason
 *  - artifact gate push-back 天然支持：observe 不写 finalResponse → shouldStop=false →
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
 * 返回 null 表示被沙箱迭代限流终止（state 已写 finalResponse=terminated）。
 */
async function runReason(
  params: RunReactLoopParams,
  state: AgentGraphState
): Promise<AgentGraphState> {
  const { db, agentInstanceId, emit } = params;
  const nextIteration = state.iteration + 1;
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
        status: "terminated",
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
  await db.insert(agentStep).values({
    id: reasonStepId,
    agentInstanceId,
    workflowRunId: params.workflowId,
    stepIndex: nextIteration,
    phase: "reason",
    thought: "Reasoning with LLM provider",
    actionType: "tool_call",
    actionJson: { llmProvider: params.def.llmProvider },
  });
  const reasonResult = await reasonNode({ ...state, iteration: nextIteration }, emit);
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

/** finalize 节点：补 finalResponse（completed / max_iterations terminated）+ snapshot。 */
function runFinalize(params: RunReactLoopParams, state: AgentGraphState): AgentGraphState {
  if (state.finalResponse) {
    snapshotState(params, "finalize", state.iteration, state);
    return state;
  }
  const exceeded = params.forceReactLoop && state.iteration >= params.def.maxIterations;
  if (exceeded) {
    params.emit({
      runId: params.runId,
      workflowId: params.workflowId,
      traceId: params.traceId,
      role: params.def.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: {
        code: "MAX_ITERATIONS",
        alertType: "iteration_exceeded",
        message: "react loop terminated by max iterations",
      },
    });
  }
  const finalResponse = exceeded
    ? { status: "terminated", reason: "max_iterations", iteration: state.iteration }
    : {
        status: "completed",
        role: params.def.role,
        iteration: state.iteration,
        observation: state.observations.at(-1) ?? {},
      };
  const merged = { ...state, finalResponse };
  snapshotState(params, "finalize", state.iteration, merged);
  return merged;
}

/** finalResponse.status 是否为终态（awaiting_approval / terminated），与原条件边一致。 */
function isTerminalStatus(state: AgentGraphState): boolean {
  const st = state.finalResponse?.status;
  return st === "awaiting_approval" || st === "terminated";
}

/**
 * 跑完整条 ReAct 循环并返回 finalize 后的 state。
 *
 * 抛出行为与原 StateGraph 一致：act 内非 HITL 异常会向上抛（caller 统一出口兜底）。
 */
export async function runReactLoop(params: RunReactLoopParams): Promise<RunReactLoopResult> {
  // resume：跳过 perceive，直接用恢复的 state 从下一轮 reason 重入；
  // fresh：先跑 perceive 建初始 context。
  let state = params.resumeFromState ?? (await runPerceive(params, params.initialState));

  // resume 时若恢复的 state 已是终态（如上一轮停在 finalize 才崩），直接 finalize 收口，
  // 不应再多跑一轮 reason。
  if (params.resumeFromState && state.finalResponse) {
    return { state: runFinalize(params, state) };
  }

  // while 主体对应原 conditionalEdges：reason→hitl_gate→act→observe→（回 reason / finalize）
  for (;;) {
    // 运行中「随时插话」：drain 本工作流面向本角色的注入消息，累加进 contextMemory，
    // 供本轮及后续 reason 拼进 LLM 上下文（软注入，不打断循环；失败 fail-soft）。
    try {
      const injected = await drainUserMessages(params.workflowId, params.def.role);
      if (injected.length > 0) {
        const prev = Array.isArray(state.contextMemory["injectedUserMessages"])
          ? (state.contextMemory["injectedUserMessages"] as string[])
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

    state = await runReason(params, state);
    // 沙箱迭代限流：reason 已写 terminated finalResponse → 直接 finalize
    if (isTerminalStatus(state)) break;

    state = await runHitlGate(params, state);
    if (isTerminalStatus(state)) break;

    state = await runAct(params, state);
    if (isTerminalStatus(state)) break;

    state = await runObserve(params, state);
    // observe 后 5 分支（对应原 :430-442）
    if (state.finalResponse) break;
    if (!params.forceReactLoop) break;
    if (shouldStopReactLoopAfterObserve(state)) break;
    if (state.iteration >= params.def.maxIterations) break;
    // 否则回 reason 继续下一轮
  }

  state = runFinalize(params, state);
  return { state };
}
