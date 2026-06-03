import { randomUUID } from "node:crypto";
import { END, START, StateGraph } from "@langchain/langgraph";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentInstance, agentStep, workflowRun } from "../../db/sqlite/schema";
import type { TaskAssignPayload } from "../../types/a2a";
import { parseLoopOptionsJson } from "../../types/loop";
import type { AgentLoopKind } from "../../types/loop";
import { sandboxExecutor } from "../sandbox-executor";
import type { RuntimeAgentDefinition } from "../types";
import { writeCheckpointSnapshot } from "./agent-checkpoint-snapshot";
import { stepStreamBus } from "./event-stream";
import { writeLlmCallLog } from "../monitor/llm-call-logger";
import { HitlAwaitingApprovalError } from "../workflow/hitl-service";
import { setWorkflowState } from "../workflow/workflow-state-machine";
import { actNode } from "./nodes/act";
import { hitlGateNode } from "./nodes/hitl-gate";
import { observeNode } from "./nodes/observe";
import { perceiveNode } from "./nodes/perceive";
import { reasonNode } from "./nodes/reason";
import { resolveForceReactLoop, shouldStopReactLoopAfterObserve } from "./react-loop-policy";
import { getCheckpointSaver } from "./sqlite-checkpoint-saver";
import { type AgentGraphState, type StepStreamEvent, createInitialGraphState } from "./state";
import { stripToolCallSentinels } from "../tools/tool-call-format";

export type ExecuteAgentReactParams = {
  runId: string;
  workflowId: string;
  traceId: string;
  def: RuntimeAgentDefinition;
  payload: TaskAssignPayload;
  /** Receiver instance id written into perceive state */
  receiverAgent: string;
  agentInstanceId?: string;
  /** SSE / step stream metadata */
  streamLoopKind?: AgentLoopKind;
  streamSource?: "native" | "a2a";
  /** When true, mark workflow_run completed/failed on exit */
  updateWorkflowStatus?: boolean;
  /**
   * Resume an existing LangGraph checkpoint (thread_id=workflowId).
   * - false (default): fresh execution; LangGraph 仍写 checkpoint，但首次调用使用 initialState
   * - true: 跳过 initialState，使用 `app.invoke(null, ...)` 从最近的 checkpoint 续跑
   */
  resume?: boolean;
  /**
   * Slot 隔离用：当一个 workflow 同时跑多个并发 ReAct（典型 MSA fan-out 场景），
   * 4 个 analyst slot 不能共用同一个 LangGraph thread —— 否则 checkpointer 主键
   * `(thread_id, checkpoint_ns, checkpoint_id)` 会让后写入的 slot 覆盖前一个的状态。
   *
   * 传入这个 suffix 后，effective thread_id = `${workflowId}:${threadSuffix}`，
   * 每个 slot 拥有独立 checkpoint 轨迹。默认空 = 单 ReAct 工作流维持原行为。
   */
  threadSuffix?: string;
};

export type ExecuteAgentReactResult = {
  finalState: AgentGraphState;
  finalResponse: Record<string, unknown>;
  terminalStatus: "completed" | "failed" | "awaiting_approval";
};

/**
 * Shared perceive→reason→act→observe ReAct loop for graph and A2A native paths.
 */
export async function executeAgentReact(
  params: ExecuteAgentReactParams
): Promise<ExecuteAgentReactResult> {
  const db = await getDb();
  const agentInstanceId = params.agentInstanceId ?? randomUUID();
  const streamLoopKind = params.streamLoopKind ?? "native";
  const streamSource = params.streamSource ?? "native";

  const wfRows = await db
    .select({ loopOptionsJson: workflowRun.loopOptionsJson })
    .from(workflowRun)
    .where(eq(workflowRun.id, params.workflowId))
    .limit(1);
  const loopOptions = parseLoopOptionsJson(wfRows[0]?.loopOptionsJson);
  const payloadParams = (params.payload.params ?? {}) as Record<string, unknown>;
  const forceReactLoop = resolveForceReactLoop({
    def: params.def,
    payloadParams,
    loopOptions,
  });

  const nowIso = new Date().toISOString();
  const existingInst = await db
    .select({ id: agentInstance.id })
    .from(agentInstance)
    .where(eq(agentInstance.id, agentInstanceId))
    .limit(1);
  if (existingInst[0]) {
    await db
      .update(agentInstance)
      .set({
        status: "running",
        currentIteration: 0,
        startedAt: nowIso,
        endedAt: null,
        errorMessage: null,
      })
      .where(eq(agentInstance.id, agentInstanceId));
  } else {
    await db.insert(agentInstance).values({
      id: agentInstanceId,
      definitionId: params.def.id,
      workflowRunId: params.workflowId,
      status: "running",
      currentIteration: 0,
      startedAt: nowIso,
    });
  }

  const initialState = createInitialGraphState({
    runId: params.runId,
    workflowId: params.workflowId,
    traceId: params.traceId,
    agentDefinition: params.def,
    inboundMessage: {
      messageId: randomUUID(),
      workflowId: params.workflowId,
      traceId: params.traceId,
      senderAgent: "system",
      receiverAgent: params.receiverAgent,
      messageType: "TASK_ASSIGN",
      payload: params.payload,
      priority: 50,
      createdAt: new Date().toISOString(),
    },
  });

  let state: AgentGraphState = initialState;

  const emit = (event: StepStreamEvent) => {
    const enriched: StepStreamEvent = {
      ...event,
      loopKind: streamLoopKind,
      source: streamSource,
    };
    state.events.push(enriched);
    stepStreamBus.publish(enriched);
  };

  const graph = new StateGraph({
    channels: {
      state: {
        value: (x: AgentGraphState, y: Partial<AgentGraphState>) => ({ ...x, ...y }),
        default: () => initialState,
      },
    },
  }) as any;

  // Phase 2.2：每个节点退出时写一份旁路 snapshot，best-effort 不阻塞节点。
  const snapshot = (phase: string, stepIndex: number, mergedState: AgentGraphState): void => {
    void writeCheckpointSnapshot({
      runId: params.runId,
      workflowId: params.workflowId,
      traceId: params.traceId,
      agentInstanceId,
      stepIndex,
      phase,
      state: mergedState,
    });
  };

  graph.addNode("perceive", async (input: { state: AgentGraphState }) => {
    const s = input.state;
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
    const partial = await perceiveNode(s);
    const merged = { ...s, ...partial };
    snapshot("perceive", 0, merged);
    return { state: merged };
  });

  graph.addNode("reason", async (input: { state: AgentGraphState }) => {
    const nextIteration = input.state.iteration + 1;
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
        stepIndex: input.state.iteration,
        ts: Date.now(),
        payload: {
          code: "SANDBOX_ITERATION_LIMIT",
          alertType: "iteration_exceeded",
          message: iterationCheck.reason ?? "iteration blocked by sandbox",
        },
      });
      const blocked = {
        ...input.state,
        finalResponse: {
          status: "terminated",
          reason: "sandbox_iteration_limit",
          iteration: input.state.iteration,
        },
      };
      snapshot("reason", input.state.iteration, blocked);
      return { state: blocked };
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
    const reasonResult = await reasonNode(
      { ...input.state, iteration: nextIteration },
      emit
    );
    // 写回 token 消耗 + reason 延迟，供 /workflow/observability 聚合渲染。
    const usage = reasonResult.meta.usage;
    const tokenCount =
      usage?.totalTokens ??
      (usage ? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0) : 0);
    const reasonText = (reasonResult.stateUpdate.reasonText ?? "").trim();
    /** 写入 agentStep.thought 前剥掉 sentinel/JSON 工具块，避免泄漏到 UI / 审计 */
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
      // 写监控字段失败不应阻塞工作流，仅打印警告
      console.warn(
        `[reason] failed to persist token/latency for step ${reasonStepId}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    /**
     * 监控 V2 P1：在 reason step 写完之后，把这次 LLM 调用单独落 `llm_call_log`。
     *
     * 与 agent_step.tokenCount 的关系：
     *   - agent_step.tokenCount 仍是聚合视图（保兼容）
     *   - llm_call_log 提供按 provider/model 跨工作流统计 + cost 估算
     *
     * 失败兜底由 writeLlmCallLog 自己 try/catch；这里**不**额外包 try，让 worker 路径
     * 看起来干净（与 act/observe 的写监控调用一致）。
     */
    if (reasonResult.meta.provider && reasonResult.meta.model) {
      await writeLlmCallLog({
        workflowRunId: params.workflowId,
        agentStepId: reasonStepId,
        /** 监控 v3 P0：让 llm_call_log 按 Agent 切分时单表 GROUP BY */
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
        ...(reasonResult.meta.finishReason
          ? { finishReason: reasonResult.meta.finishReason }
          : {}),
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
    const merged = { ...input.state, iteration: nextIteration, ...reasonResult.stateUpdate };
    snapshot("reason", nextIteration, merged);
    return { state: merged };
  });

  graph.addNode("hitl_gate", async (input: { state: AgentGraphState }) => {
    const s = input.state;
    const partial = await hitlGateNode(s, emit, agentInstanceId);
    const merged = { ...s, ...partial };
    snapshot("hitl_gate", s.iteration, merged);
    return { state: merged };
  });

  graph.addNode("act", async (input: { state: AgentGraphState }) => {
    const s = input.state;
    if (s.finalResponse) return { state: s };
    const actStepId = randomUUID();
    await db.insert(agentStep).values({
      id: actStepId,
      agentInstanceId,
      workflowRunId: params.workflowId,
      stepIndex: s.iteration,
      phase: "act",
      thought: "Execute selected tool",
      actionType: "tool_call",
      actionJson: { plannedAction: s.plannedAction },
    });
    try {
      const partial = await actNode(s, emit, agentInstanceId, actStepId);
      const merged = { ...s, ...partial };
      snapshot("act", s.iteration, merged);
      return { state: merged };
    } catch (err) {
      if (err instanceof HitlAwaitingApprovalError) {
        /**
         * P0-C：HITL pause 只设置 finalResponse，让 `executeAgentReact` 的 finally
         * 统一 emit final 帧（避免与 finalize 节点后的 emit 形成"双 final"）。
         */
        const awaiting = {
          status: "awaiting_approval",
          hitlRequestId: err.requestId,
          title: err.message,
          iteration: s.iteration,
          role: params.def.role,
        };
        const merged = { ...s, finalResponse: awaiting };
        snapshot("act", s.iteration, merged);
        return { state: merged };
      }
      throw err;
    }
  });

  graph.addNode("observe", async (input: { state: AgentGraphState }) => {
    const s = input.state;
    const partial = await observeNode(s, emit, agentInstanceId);
    const merged = { ...s, ...partial };
    snapshot("observe", s.iteration, merged);
    return { state: merged };
  });

  graph.addNode("finalize", async (input: { state: AgentGraphState }) => {
    const s = input.state;
    if (s.finalResponse) {
      snapshot("finalize", s.iteration, s);
      return { state: s };
    }
    const exceeded = forceReactLoop && s.iteration >= params.def.maxIterations;
    if (exceeded) {
      emit({
        runId: params.runId,
        workflowId: params.workflowId,
        traceId: params.traceId,
        role: params.def.role,
        type: "observe",
        stepIndex: s.iteration,
        ts: Date.now(),
        payload: {
          code: "MAX_ITERATIONS",
          alertType: "iteration_exceeded",
          message: "graph terminated by max iterations",
        },
      });
    }
    const finalResponse = exceeded
      ? { status: "terminated", reason: "max_iterations", iteration: s.iteration }
      : {
          status: "completed",
          role: params.def.role,
          iteration: s.iteration,
          observation: s.observations.at(-1) ?? {},
        };
    const merged = { ...s, finalResponse };
    snapshot("finalize", s.iteration, merged);
    return { state: merged };
  });

  graph.addEdge(START, "perceive");
  graph.addEdge("perceive", "reason");
  graph.addEdge("reason", "hitl_gate");
  graph.addConditionalEdges(
    "hitl_gate",
    (input: { state: AgentGraphState }) => {
      const st = input.state.finalResponse?.status;
      if (st === "awaiting_approval" || st === "terminated") return "finalize";
      return "act";
    },
    { act: "act", finalize: "finalize" }
  );
  graph.addConditionalEdges(
    "act",
    (input: { state: AgentGraphState }) => {
      const st = input.state.finalResponse?.status;
      if (st === "awaiting_approval" || st === "terminated") return "finalize";
      return "observe";
    },
    { observe: "observe", finalize: "finalize" }
  );
  graph.addConditionalEdges(
    "observe",
    (input: { state: AgentGraphState }) => {
      if (input.state.finalResponse) return "finalize";
      if (!forceReactLoop) return "finalize";
      if (shouldStopReactLoopAfterObserve(input.state)) return "finalize";
      if (input.state.iteration < params.def.maxIterations) {
        return "reason";
      }
      return "finalize";
    },
    { reason: "reason", finalize: "finalize" }
  );
  graph.addEdge("finalize", END);

  const app = graph.compile({ checkpointer: getCheckpointSaver() });
  const effectiveThreadId = params.threadSuffix
    ? `${params.workflowId}:${params.threadSuffix}`
    : params.workflowId;
  const runnableConfig = {
    configurable: { thread_id: effectiveThreadId },
    recursionLimit: Math.max(50, params.def.maxIterations * 8),
  };

  let invokeInput: { state: AgentGraphState } | null = { state: initialState };
  if (params.resume) {
    const tuple = await getCheckpointSaver().getTuple({
      configurable: { thread_id: params.workflowId },
    });
    if (tuple) {
      invokeInput = null;
      await db
        .update(workflowRun)
        .set({ resumeCount: sql`${workflowRun.resumeCount} + 1` })
        .where(eq(workflowRun.id, params.workflowId));
    }
  }

  /**
   * P0-C：把 `app.invoke` 包进 try/catch，让"成功/HITL pause/失败"三种退出
   * 路径都汇聚到下面的统一出口（status 写 + final 帧 emit），从而：
   *   - SSE final 帧每个 runId 只发 1 次（修复"双 final"导致前端闪烁/重复处理）
   *   - workflow_run.status / agent_instance.status 写入收敛到一个地方（修复
   *     graph-factory / a2a-react-task / executeAgentReact 三处分别写、容易
   *     漂移的问题）
   *   - HitlAwaitingApprovalError 不再抛到 caller —— graph 内的 act 节点已经
   *     把它转 finalResponse，这里的 catch 是兜底（极端情况 finalize 之外的
   *     节点抛 HITL）
   *
   * caller 的 try/catch 仍保留 rethrow 行为：除 HitlAwaitingApprovalError 之外
   * 的异常继续上抛，caller 用来发 fail TASK_RESULT / 写 agent_instance.errorMessage。
   */
  let rethrow: unknown = null;
  try {
    const result = (await app.invoke(invokeInput, runnableConfig)) as {
      state: AgentGraphState;
    };
    state = result.state;
  } catch (err) {
    if (err instanceof HitlAwaitingApprovalError) {
      state = {
        ...state,
        finalResponse: {
          status: "awaiting_approval",
          hitlRequestId: err.requestId,
          title: err.message,
          iteration: state.iteration,
          role: params.def.role,
        },
      };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        runId: params.runId,
        workflowId: params.workflowId,
        traceId: params.traceId,
        role: params.def.role,
        type: "error",
        stepIndex: state.iteration,
        ts: Date.now(),
        payload: { error: message },
      });
      state = {
        ...state,
        finalResponse: {
          status: "terminated",
          reason: "exception",
          error: message,
          iteration: state.iteration,
          role: params.def.role,
        },
      };
      rethrow = err;
    }
  }

  const finalResponse = (state.finalResponse ?? { status: "completed" }) as Record<string, unknown>;
  const frStatus = String(finalResponse["status"] ?? "completed");
  const terminalStatus: ExecuteAgentReactResult["terminalStatus"] =
    frStatus === "awaiting_approval"
      ? "awaiting_approval"
      : frStatus === "terminated"
        ? "failed"
        : "completed";

  await db
    .update(agentInstance)
    .set({
      status:
        terminalStatus === "failed"
          ? "error"
          : terminalStatus === "awaiting_approval"
            ? "running"
            : "stopped",
      endedAt: terminalStatus === "awaiting_approval" ? null : new Date().toISOString(),
      ...(terminalStatus === "failed" && rethrow
        ? {
            errorMessage:
              (rethrow instanceof Error ? rethrow.message : String(rethrow)).slice(0, 2000),
          }
        : {}),
    })
    .where(eq(agentInstance.id, agentInstanceId));

  if (params.updateWorkflowStatus) {
    await setWorkflowState(params.workflowId, terminalStatus, {
      reason: "execute-agent-react",
    });
  }

  emit({
    runId: params.runId,
    workflowId: params.workflowId,
    traceId: params.traceId,
    role: params.def.role,
    type: "final",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: finalResponse,
  });

  if (rethrow) throw rethrow;
  return { finalState: state, finalResponse, terminalStatus };
}
