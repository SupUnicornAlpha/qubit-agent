import { randomUUID } from "node:crypto";
import type { A2AMessageEnvelope, TaskAssignPayload, TaskProgressPayload } from "../../types/a2a";
import { stepStreamBus } from "../host/event-stream";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { resolveTopologyTaskHeartbeatMs } from "../orchestration/topology-dispatch";
import { resolveCoreBackend } from "../prime/core-runtime";
import { runOrchestratorTaskViaCore } from "../prime/run-orchestrator-via-core";
import { reasonSpecialistViaCore, resolveCalleeSpecId } from "../prime/run-specialist-via-core";
import type { RuntimeHandlerContext } from "../types";
import {
  clearA2ATaskCancellation,
  isA2ATaskCancellationRequested,
  requestA2ATaskCancellation,
} from "./a2a-task-cancellation";
import {
  completeA2ATask,
  listOpenChildA2ATasks,
  markA2ATaskWorking,
  recordA2ATaskProgress,
} from "./a2a-task-service";
import { buildTaskResult } from "./task-result";

function taskFailureDetails(finalResponse: Record<string, unknown>): {
  status: "partial" | "failed" | "timeout" | "cancelled";
  errorCode: string;
  errorMessage: string;
} {
  const reason = String(finalResponse.reason ?? "task_failed");
  const answer = String(finalResponse.error ?? finalResponse.answerText ?? "").trim();
  if (reason === "task_deadline_exceeded" || reason === "reason_timeout") {
    return { status: "timeout", errorCode: reason, errorMessage: answer || "专家子任务执行超时" };
  }
  if (reason === "a2a_task_cancelled" || reason === "user_cancelled") {
    return { status: "cancelled", errorCode: reason, errorMessage: answer || "专家子任务已取消" };
  }
  if (String(finalResponse.status ?? "") === "partial") {
    return { status: "partial", errorCode: reason, errorMessage: answer || "专家子任务部分完成" };
  }
  return { status: "failed", errorCode: reason, errorMessage: answer || "专家子任务未完成" };
}

function taskSummary(finalResponse: Record<string, unknown>): string | undefined {
  for (const candidate of [finalResponse.answerText, finalResponse.summary, finalResponse.reason]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 500);
  }
  return undefined;
}

/**
 * Topology dispatch is a child task of an already-running workflow. Its instance
 * may fail or time out, but only the orchestrator that owns the user-facing run
 * may decide the workflow terminal state.
 */
export function ownsWorkflowTerminalState(payload: TaskAssignPayload): boolean {
  return payload.taskType !== "topology_dispatch";
}

export type TopologyTaskEvidence = {
  kind: "market_data" | "tool_result";
  verified: true;
  sourceTool: string | null;
  result: unknown;
};

/** Evidence extract from Host-projected tool/observation tails (Core / bridge). */
export function extractTopologyTaskEvidence(
  role: string,
  state: {
    toolCalls: Array<Record<string, unknown>>;
    observations: Array<Record<string, unknown>>;
  }
): TopologyTaskEvidence | null {
  const successfulTools = [...state.toolCalls]
    .reverse()
    .filter((call) => call.status === "success");
  const sourceTool =
    (role === "market_data"
      ? successfulTools.find((call) =>
          /(fetch_klines|fetch_bars|fetch_ticks|fetch_quote|fetch_order_book|fetch_trades|get_quote|get_price)/i.test(
            String(call.toolName ?? "")
          )
        )
      : successfulTools.find(
          (call) =>
            !["market.readiness", "market.data_sources", "market.resolve_symbol"].includes(
              String(call.toolName ?? "")
            )
        )
    )?.toolName ?? null;

  for (const observation of [...state.observations].reverse()) {
    const raw =
      observation.connectorResult ??
      observation.mcpResult ??
      observation.builtinResult ??
      observation.analystTeamResult;
    if (raw === undefined || raw === null) continue;

    if (role === "market_data" && Array.isArray(raw) && raw.length > 0) {
      const bars = raw.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item)
      );
      if (bars.length === 0) continue;
      const latest = [...bars]
        .sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")))
        .at(-1);
      return {
        kind: "market_data",
        verified: true,
        sourceTool: typeof sourceTool === "string" ? sourceTool : null,
        result: {
          dataAvailable: true,
          barCount: bars.length,
          symbol: latest?.symbol ?? bars[0]?.symbol ?? null,
          exchange: latest?.exchange ?? bars[0]?.exchange ?? null,
          latestClose: latest?.close ?? null,
          asof: latest?.timestamp ?? null,
        },
      };
    }
    if (
      role === "market_data" &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      typeof (raw as Record<string, unknown>).lastPrice === "number"
    ) {
      const quote = raw as Record<string, unknown>;
      return {
        kind: "market_data",
        verified: true,
        sourceTool: typeof sourceTool === "string" ? sourceTool : null,
        result: {
          dataAvailable: true,
          dataKind: "quote",
          symbol: quote.symbol ?? null,
          exchange: quote.exchange ?? null,
          source: quote.source ?? null,
          lastPrice: quote.lastPrice,
          asof: quote.timestamp ?? null,
          freshnessMs: quote.freshnessMs ?? null,
        },
      };
    }
    if (role === "market_data") continue;

    return {
      kind: "tool_result",
      verified: true,
      sourceTool: typeof sourceTool === "string" ? sourceTool : null,
      result: raw,
    };
  }
  return null;
}

export function resolveA2aExecutionRunId(payload: TaskAssignPayload): string {
  return payload.executionRunId?.trim() || randomUUID();
}

export function resolveA2aSpecialistMaxIterations(configured: number): number {
  // 专家任务需要完成“检查数据源 → 解析标的 → 拉数据 → 降级重试 → 交叉验证 → 总结”。
  return Math.min(Math.max(24, configured), 32);
}

export function resolveA2aOrchestratorMaxIterations(configured: number): number {
  return Math.max(1, Math.floor(configured));
}

async function sendTaskProgress(
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope,
  payload: TaskAssignPayload,
  event: { phase: TaskProgressPayload["phase"]; iteration?: number; detail?: string }
): Promise<void> {
  const progress: TaskProgressPayload = {
    taskId: payload.taskId,
    phase: event.phase,
    ...(event.iteration !== undefined ? { iteration: Math.max(0, event.iteration) } : {}),
    role: ctx.definition.role,
    ...(event.detail ? { detail: event.detail.slice(0, 500) } : {}),
    ts: new Date().toISOString(),
  };
  await ctx.send({
    workflowId: msg.workflowId,
    traceId: msg.traceId,
    receiverAgent: msg.senderAgent,
    messageType: "TASK_PROGRESS",
    payload: progress,
    priority: msg.priority,
  });
}

/**
 * A2A TASK_ASSIGN → **Rust Core only** (Phase B).
 * Bun Host remains the A2A / SSE / persistence adapter — not a second Agent runtime.
 */
export async function runA2aReactTaskAssign(
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope,
  payload: TaskAssignPayload
): Promise<{ finalResponse: Record<string, unknown>; terminalStatus: string } | void> {
  if (resolveCoreBackend() !== "rust") {
    throw new Error(
      "A2A task assign requires QUBIT_CORE_BACKEND=rust (Phase B: TS Agent runtime removed). " +
        "Start qubit-app-server and attach Prime Core."
    );
  }

  const workflowId = msg.workflowId;
  const traceId = msg.traceId;
  const ownsTerminalState = ownsWorkflowTerminalState(payload);
  const runId = resolveA2aExecutionRunId(payload);
  const definition = {
    ...ctx.definition,
    maxIterations:
      ctx.definition.role === "orchestrator"
        ? resolveA2aOrchestratorMaxIterations(ctx.definition.maxIterations)
        : ownsTerminalState
          ? ctx.definition.maxIterations
          : resolveA2aSpecialistMaxIterations(ctx.definition.maxIterations),
  };
  const startedAt = Date.now();
  const heartbeatMs = resolveTopologyTaskHeartbeatMs();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const emitProgress = async (event: {
    phase: TaskProgressPayload["phase"];
    iteration?: number;
    detail?: string;
  }) => {
    const progress: TaskProgressPayload = {
      taskId: payload.taskId,
      phase: event.phase,
      ...(event.iteration !== undefined ? { iteration: Math.max(0, event.iteration) } : {}),
      role: ctx.definition.role,
      ...(event.detail ? { detail: event.detail.slice(0, 500) } : {}),
      ts: new Date().toISOString(),
    };
    await recordA2ATaskProgress(payload.taskId, progress);
    await sendTaskProgress(ctx, msg, payload, event);
  };

  const cancelOpenChildrenForTerminal = async (status: "completed" | "partial" | "failed") => {
    if (!ownsTerminalState) return;
    const openChildren = await listOpenChildA2ATasks(workflowId, payload.taskId);
    await Promise.all(
      openChildren.map((task) =>
        requestA2ATaskCancellation(task.id, `workflow_${status}_by_parent`)
      )
    );
  };

  try {
    if (ctx.definition.role === "orchestrator") {
      return runOrchestratorTaskViaCore(ctx, msg, payload);
    }

    await markA2ATaskWorking(payload.taskId);
    await emitProgress({ phase: "start", iteration: 0, detail: "prime_core_invoke" });
    if (!ownsTerminalState) {
      heartbeatTimer = setInterval(() => {
        void emitProgress({ phase: "heartbeat", detail: "prime_core_invoke" });
      }, heartbeatMs);
      (heartbeatTimer as { unref?: () => void }).unref?.();
    }

    if (isA2ATaskCancellationRequested(payload.taskId)) {
      throw new Error("a2a_task_cancelled");
    }

    const params = (payload.params ?? {}) as Record<string, unknown>;
    const goal =
      (typeof params.goal === "string" && params.goal.trim()) ||
      (typeof params.context === "string" && params.context.trim()) ||
      `A2A task ${payload.taskType} for ${ctx.definition.role}`;
    const context =
      typeof params.context === "string" && params.context !== goal ? params.context : undefined;

    const out = await reasonSpecialistViaCore({
      workflowRunId: workflowId,
      runId,
      traceId: msg.traceId,
      calleeSpecId: resolveCalleeSpecId({
        definitionId: definition.id,
        role: ctx.definition.role,
      }),
      role: ctx.definition.role,
      goal,
      ...(context ? { context } : {}),
      maxIterations: definition.maxIterations,
    });

    const failed =
      out.state === "failed" || out.state === "cancelled" || out.state === "timed_out";
    const partial =
      !failed &&
      (out.state !== "completed" ||
        out.deliveryStatus === "partial" ||
        out.deliveryStatus === "delivered_with_gaps" ||
        out.deliveryStatus === "failed" ||
        out.deliveryStatus === "cancelled");
    const terminalStatus: "completed" | "partial" | "failed" = failed
      ? "failed"
      : partial
        ? "partial"
        : "completed";
    const finalResponse: Record<string, unknown> = {
      answerText: out.text,
      reasonText: out.text,
      status: terminalStatus,
      backend: "rust",
      invocationId: out.invocationId,
      childSessionId: out.childSessionId,
    };

    stepStreamBus.publish({
      runId,
      workflowId,
      traceId,
      role: ctx.definition.role,
      type: terminalStatus === "failed" ? "error" : "final",
      stepIndex: 0,
      ts: Date.now(),
      payload:
        terminalStatus === "failed"
          ? { error: out.text, backend: "rust" }
          : { answerText: out.text, backend: "rust" },
      loopKind: "native",
      source: "a2a",
    });

    if (ownsTerminalState) {
      await cancelOpenChildrenForTerminal(terminalStatus);
      onWorkflowTerminal(workflowId, terminalStatus);
    }

    const failure =
      terminalStatus !== "completed"
        ? {
            status: terminalStatus,
            errorCode: "prime_core_invoke",
            errorMessage: out.text.slice(0, 500),
          }
        : null;
    const taskResultPayload = buildTaskResult(payload.taskId, ctx.definition.role, {
      status: failure?.status ?? "completed",
      success: terminalStatus === "completed",
      result: finalResponse,
      ...(failure ? { errorCode: failure.errorCode, errorMessage: failure.errorMessage } : {}),
      summary: out.text.slice(0, 500),
      durationMs: Date.now() - startedAt,
    });
    await completeA2ATask(payload.taskId, taskResultPayload);
    await ctx.send({
      workflowId,
      traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: taskResultPayload,
      priority: msg.priority,
    });
    return { finalResponse, terminalStatus };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const details = taskFailureDetails({ error: message, reason: message });
    if (ownsTerminalState) {
      await cancelOpenChildrenForTerminal("failed");
      onWorkflowTerminal(workflowId, "failed");
    }
    const taskResultPayload = buildTaskResult(payload.taskId, ctx.definition.role, {
      status: details.status,
      success: false,
      errorCode: details.errorCode,
      errorMessage: details.errorMessage,
      result: { error: message, backend: "rust" },
      ...(taskSummary({ error: message }) ? { summary: taskSummary({ error: message }) } : {}),
      durationMs: Date.now() - startedAt,
    });
    await completeA2ATask(payload.taskId, taskResultPayload);
    await ctx.send({
      workflowId,
      traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: taskResultPayload,
      priority: msg.priority,
    });
    throw err;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    clearA2ATaskCancellation(payload.taskId);
    stepStreamBus.close(runId);
  }
}
