import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentInstance, workflowRun } from "../../db/sqlite/schema";
import type { TaskAssignPayload } from "../../types/a2a";
import { parseLoopOptionsJson } from "../../types/loop";
import type { AgentLoopKind } from "../../types/loop";
import { runReactLoop } from "../react/run-react-loop";
import type { RuntimeAgentDefinition } from "../types";
import {
  loadLatestCheckpointSnapshot,
  restoreStateFromSnapshot,
} from "./agent-checkpoint-snapshot";
import { stepStreamBus } from "./event-stream";
import { HitlAwaitingApprovalError } from "../workflow/hitl-service";
import { setWorkflowState } from "../workflow/workflow-state-machine";
import { resolveForceReactLoop } from "./react-loop-policy";
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
   * Resume from a self-built `agent_checkpoint_snapshot`。
   *
   * - false（默认）：fresh 执行，从 perceive 起跑。
   * - true：按 `workflowId` 取最近一份快照（注意 resume 会换新 runId，故按 workflow
   *   而非 runId 定位），`restoreStateFromSnapshot` 还原运行态后**跳过 perceive**
   *   从下一轮 reason 重入；并把 `workflow_run.resumeCount + 1`。
   *   找不到快照时 fail-soft 回退为 fresh 执行（与原 LangGraph getTuple 落空时
   *   用 initialState 跑的行为一致）。
   */
  resume?: boolean;
  /**
   * 历史遗留：原 LangGraph 并发 thread 隔离用。
   *
   * 自研 snapshot 天然按 `runId` 隔离（MSA 每个 slot 独立 runId），不再需要 thread
   * 后缀。阶段 1 保留为 no-op 过渡参数，阶段 4/5 删除。
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

  /**
   * emit 把 SSE 帧推进 `initialState.events`（节点 merge 用 `{...s,...partial}` 浅拷贝，
   * events 数组引用全程共享），再发布到 stepStreamBus。与原 StateGraph 行为一致。
   */
  const emit = (event: StepStreamEvent) => {
    const enriched: StepStreamEvent = {
      ...event,
      loopKind: streamLoopKind,
      source: streamSource,
    };
    initialState.events.push(enriched);
    stepStreamBus.publish(enriched);
  };

  /**
   * 自研 resume：按 workflowId 取最近快照还原运行态。
   *
   * 注意按 workflowId（而非 runId）定位：resume 每次换新 runId（graph-factory
   * resumeRoleTask:422），按 runId 永远找不到上一轮的快照。单 ReAct 工作流一个
   * workflow 只有一条 ReAct 轨迹，按 workflow 取最近天然正确（MSA fan-out 不走
   * 此 resume 路径，slot 各自独立 runId 且不 resume）。
   *
   * def 用 caller 传入的完整 `params.def`（快照里的 def 被裁剪），符合
   * restoreStateFromSnapshot 的契约。inboundMessage 用本次调用的（携带 resume
   * payload / hitlApproval），覆盖快照里旧的。
   */
  let resumeFromState: AgentGraphState | undefined;
  if (params.resume) {
    const loaded = await loadLatestCheckpointSnapshot(params.workflowId);
    if (loaded) {
      const restored = restoreStateFromSnapshot(
        loaded,
        params.def,
        initialState.inboundMessage
      );
      // 让 resume 后的 state 与 emit 共享同一个 events 数组引用（emit 推 initialState.events），
      // 与 fresh 路径行为一致；快照里的 eventsTail 有损且不重放，丢弃即可。
      resumeFromState = {
        ...restored.state,
        runId: params.runId,
        events: initialState.events,
      };
      await db
        .update(workflowRun)
        .set({ resumeCount: sql`${workflowRun.resumeCount} + 1` })
        .where(eq(workflowRun.id, params.workflowId));
    } else {
      console.warn(
        `[execute-agent-react] resume requested but no snapshot for workflow=${params.workflowId}; falling back to fresh`
      );
    }
  }

  /**
   * P0-C：把 ReAct 循环包进 try/catch，让"成功/HITL pause/失败"三种退出
   * 路径都汇聚到下面的统一出口（status 写 + final 帧 emit），从而：
   *   - SSE final 帧每个 runId 只发 1 次（修复"双 final"导致前端闪烁/重复处理）
   *   - workflow_run.status / agent_instance.status 写入收敛到一个地方（修复
   *     graph-factory / a2a-react-task / executeAgentReact 三处分别写、容易
   *     漂移的问题）
   *   - HitlAwaitingApprovalError 不再抛到 caller —— 循环内的 act 已经
   *     把它转 finalResponse，这里的 catch 是兜底（极端情况非 act 节点抛 HITL）
   *
   * caller 的 try/catch 仍保留 rethrow 行为：除 HitlAwaitingApprovalError 之外
   * 的异常继续上抛，caller 用来发 fail TASK_RESULT / 写 agent_instance.errorMessage。
   */
  let rethrow: unknown = null;
  try {
    const result = await runReactLoop({
      db,
      runId: params.runId,
      workflowId: params.workflowId,
      traceId: params.traceId,
      def: params.def,
      payload: params.payload,
      agentInstanceId,
      forceReactLoop,
      initialState,
      ...(resumeFromState ? { resumeFromState } : {}),
      emit,
    });
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
