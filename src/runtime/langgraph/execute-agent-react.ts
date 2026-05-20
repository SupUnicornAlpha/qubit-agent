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
import { actNode } from "./nodes/act";
import { observeNode } from "./nodes/observe";
import { perceiveNode } from "./nodes/perceive";
import { reasonNode } from "./nodes/reason";
import { resolveForceReactLoop, shouldStopReactLoopAfterObserve } from "./react-loop-policy";
import { getCheckpointSaver } from "./sqlite-checkpoint-saver";
import { type AgentGraphState, type StepStreamEvent, createInitialGraphState } from "./state";

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
};

export type ExecuteAgentReactResult = {
  finalState: AgentGraphState;
  finalResponse: Record<string, unknown>;
  terminalStatus: "completed" | "failed";
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
    const partial = await reasonNode({ ...input.state, iteration: nextIteration }, emit);
    const merged = { ...input.state, iteration: nextIteration, ...partial };
    snapshot("reason", nextIteration, merged);
    return { state: merged };
  });

  graph.addNode("act", async (input: { state: AgentGraphState }) => {
    const s = input.state;
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
    const partial = await actNode(s, emit, agentInstanceId, actStepId);
    const merged = { ...s, ...partial };
    snapshot("act", s.iteration, merged);
    return { state: merged };
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
  graph.addEdge("reason", "act");
  graph.addEdge("act", "observe");
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
  const runnableConfig = {
    configurable: { thread_id: params.workflowId },
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

  const result = (await app.invoke(invokeInput, runnableConfig)) as { state: AgentGraphState };
  state = result.state;

  const finalResponse = (state.finalResponse ?? { status: "completed" }) as Record<string, unknown>;
  const terminalStatus = finalResponse["status"] === "terminated" ? "failed" : "completed";

  await db
    .update(agentInstance)
    .set({
      status: terminalStatus === "failed" ? "error" : "stopped",
      endedAt: new Date().toISOString(),
    })
    .where(eq(agentInstance.id, agentInstanceId));

  if (params.updateWorkflowStatus) {
    await db
      .update(workflowRun)
      .set({
        status: terminalStatus,
        endedAt: new Date().toISOString(),
      })
      .where(eq(workflowRun.id, params.workflowId));
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

  return { finalState: state, finalResponse, terminalStatus };
}
