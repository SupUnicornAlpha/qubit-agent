import { randomUUID } from "node:crypto";
import type { A2AMessageEnvelope, TaskAssignPayload, TaskProgressPayload } from "../../types/a2a";
import { stepStreamBus } from "../react/event-stream";
import { executeAgentReact } from "../react/execute-agent-react";
import type { AgentGraphState } from "../react/state";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { resolveTopologyTaskHeartbeatMs } from "../orchestration/topology-dispatch";
import { resolveCoreBackend } from "../prime/core-runtime";
import { runOrchestratorTaskViaCore } from "../prime/run-orchestrator-via-core";
import {
  reasonSpecialistViaCore,
  resolveCalleeSpecId,
} from "../prime/run-specialist-via-core";
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

export function extractTopologyTaskEvidence(
  role: string,
  state: Pick<AgentGraphState, "toolCalls" | "observations">
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

/**
 * Run the shared ReAct loop for an A2A TASK_ASSIGN, then reply with TASK_RESULT.
 */
export function resolveA2aExecutionRunId(payload: TaskAssignPayload): string {
  return payload.executionRunId?.trim() || randomUUID();
}

export function resolveA2aSpecialistMaxIterations(configured: number): number {
  // 专家任务需要完成“检查数据源 → 解析标的 → 拉数据 → 降级重试 → 交叉验证 → 总结”。
  // 8 轮会在正常恢复链路尚未产出结论时截断。墙钟 deadline、可取消任务和 sandbox
  // policy 已是独立护栏，因此这里提供可完成研究的执行预算，而不是第二个失败阈值。
  return Math.min(Math.max(24, configured), 32);
}

/**
 * The workflow's loopOptionsJson is the authoritative orchestration budget.
 * Do not turn every A2A orchestration into 64 turns: that masks missing stop
 * conditions and multiplies stale tool proposals.  Callers that genuinely
 * need a larger budget set it explicitly on the workflow.
 */
export function resolveA2aOrchestratorMaxIterations(configured: number): number {
  return Math.max(1, Math.floor(configured));
}

async function sendTaskProgress(
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope,
  payload: TaskAssignPayload,
  event: {
    phase: TaskProgressPayload["phase"];
    iteration?: number;
    detail?: string;
  }
): Promise<void> {
  // Topology children report lease health back to the assigner; primary workflow
  // owners (non-topology) have no gather waiter to renew.
  if (ownsWorkflowTerminalState(payload)) return;
  try {
    await ctx.send({
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_PROGRESS",
      payload: {
        taskId: payload.taskId,
        phase: event.phase,
        ...(event.iteration !== undefined ? { iteration: Math.max(0, event.iteration) } : {}),
        role: ctx.definition.role,
        ...(event.detail ? { detail: event.detail.slice(0, 500) } : {}),
        ts: new Date().toISOString(),
      } satisfies TaskProgressPayload,
      priority: 20,
    });
  } catch (err) {
    console.warn(
      `[a2a-react-task] TASK_PROGRESS failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function runA2aReactTaskAssign(
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope
): Promise<
  | { finalResponse: Record<string, unknown>; terminalStatus: "completed" | "partial" | "failed" }
  | undefined
> {
  const payload = msg.payload as TaskAssignPayload;
  /**
   * `dispatchTaskToRole` 会把这个 ID 先返回给 HTTP 调用方，前端随即订阅对应 SSE。
   * 必须复用 payload 中的 executionRunId；历史上这里再次 randomUUID，导致调用方
   * 永远订阅到一条没有 token 的空流，只能等最终落库后一次性看到完整答案。
   */
  const runId = resolveA2aExecutionRunId(payload);
  const traceId = msg.traceId;
  const workflowId = msg.workflowId;
  const ownsTerminalState = ownsWorkflowTerminalState(payload);
  const definition = {
    ...ctx.definition,
    maxIterations:
      ctx.definition.role === "orchestrator"
        ? resolveA2aOrchestratorMaxIterations(ctx.definition.maxIterations)
        : ownsTerminalState
          ? ctx.definition.maxIterations
          : resolveA2aSpecialistMaxIterations(ctx.definition.maxIterations),
  };

  /**
   * 自研 snapshot 续跑：workflow_resume 的 payload.params.resume=true 时，
   * executeAgentReact 会按 workflowId 取最近一份 agent_checkpoint_snapshot 还原运行态
   * 并从下一轮 reason 重入（进程重启恢复 / sweep 续跑走这条线）。HITL approve 重派
   * 不带 resume —— 让 orchestrator 重跑 ReAct，由 hitlApproval 自然进入上下文。
   */
  const resume = (payload.params as Record<string, unknown> | undefined)?.resume === true;
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
    // The durable A2A event is authoritative; a transient local bus failure
    // must not erase progress or make a restarted parent lose the task.
    await recordA2ATaskProgress(payload.taskId, progress);
    await sendTaskProgress(ctx, msg, payload, event);
  };

  const cancelOpenChildrenForTerminal = async (status: "completed" | "partial" | "failed") => {
    if (!ownsTerminalState) return;
    // A terminal parent must not leave specialists consuming tools in the
    // background. The interrupt is cooperative in-process and the task state
    // is persisted for reconnect/recovery.
    const openChildren = await listOpenChildA2ATasks(workflowId, payload.taskId);
    await Promise.all(
      openChildren.map((task) =>
        requestA2ATaskCancellation(task.id, `workflow_${status}_by_parent`)
      )
    );
  };

  try {
    // Prime Core valve: orchestrator → turn.start；专家 role → agent.invoke。
    // 避免在 rust 后端再进 executeAgentReact（为裁剪 TS ReAct 铺路）。
    if (resolveCoreBackend() === "rust") {
      if (ctx.definition.role === "orchestrator") {
        return runOrchestratorTaskViaCore(ctx, msg, payload);
      }

      await markA2ATaskWorking(payload.taskId);
      await emitProgress({ phase: "start", iteration: 0, detail: "prime_core_invoke" });
      const params = (payload.params ?? {}) as Record<string, unknown>;
      const goal =
        (typeof params.goal === "string" && params.goal.trim()) ||
        (typeof params.context === "string" && params.context.trim()) ||
        `A2A task ${payload.taskType} for ${ctx.definition.role}`;
      const context =
        typeof params.context === "string" && params.context !== goal
          ? params.context
          : undefined;

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

      const failed = out.state === "failed" || out.state === "cancelled";
      const terminalStatus: "completed" | "partial" | "failed" = failed
        ? "failed"
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
        type: failed ? "error" : "final",
        stepIndex: 0,
        ts: Date.now(),
        payload: failed
          ? { error: out.text, backend: "rust" }
          : { answerText: out.text, backend: "rust" },
        loopKind: "native",
        source: "a2a",
      });

      if (ownsTerminalState) {
        await cancelOpenChildrenForTerminal(terminalStatus);
        onWorkflowTerminal(workflowId, terminalStatus);
      }

      const failure = failed
        ? {
            status: "failed" as const,
            errorCode: "prime_core_invoke",
            errorMessage: out.text.slice(0, 500),
          }
        : null;
      const taskResultPayload = buildTaskResult(payload.taskId, ctx.definition.role, {
        status: failure?.status ?? "completed",
        success: terminalStatus === "completed",
        result: finalResponse,
        ...(failure
          ? { errorCode: failure.errorCode, errorMessage: failure.errorMessage }
          : {}),
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
    }

    await markA2ATaskWorking(payload.taskId);
    await emitProgress({ phase: "start", iteration: 0 });
    if (!ownsWorkflowTerminalState(payload)) {
      heartbeatTimer = setInterval(() => {
        void emitProgress({ phase: "heartbeat" });
      }, heartbeatMs);
      (heartbeatTimer as { unref?: () => void }).unref?.();
    }

    const { finalState, finalResponse, terminalStatus } = await executeAgentReact({
      runId,
      workflowId,
      traceId,
      def: definition,
      payload,
      receiverAgent: ctx.instance.instanceId,
      streamLoopKind: "native",
      streamSource: "a2a",
      updateWorkflowStatus: ownsTerminalState,
      resume,
      isTaskCancellationRequested: () => isA2ATaskCancellationRequested(payload.taskId),
      onTaskProgress: (event) => emitProgress(event),
    });

    /**
     * P0-3 R4：awaiting_approval 不是终态，不能调 onWorkflowTerminal —— 之前那样调
     * 会把"等审批"的工作流跑进 quality snapshot / alert 评估，污染监控指标，
     * 而且类型上 onWorkflowTerminal 只接受 completed/failed，是借 union 宽度蒙混过的。
     *
     * P0-3 R5：不能发 TASK_RESULT(success=true)。但 V2 会发可观察的
     * awaiting_approval receipt，避免上游 Gather 无期限等到自己的 timeout。
     */
    if (terminalStatus === "awaiting_approval") {
      const taskResultPayload = buildTaskResult(payload.taskId, ctx.definition.role, {
        status: "awaiting_approval",
        errorCode: "awaiting_approval",
        errorMessage: "专家子任务正在等待人工审批",
        result: finalResponse,
        ...(taskSummary(finalResponse) ? { summary: taskSummary(finalResponse) } : {}),
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
      return;
    }

    if (ownsTerminalState) {
      await cancelOpenChildrenForTerminal(terminalStatus);
      onWorkflowTerminal(workflowId, terminalStatus);
    }

    const taskEvidence = ownsTerminalState
      ? null
      : extractTopologyTaskEvidence(ctx.definition.role, finalState);
    const taskResult = taskEvidence
      ? {
          ...finalResponse,
          taskEvidence,
          originalTerminalStatus: terminalStatus,
          // Evidence remains useful to the parent, but never upgrades a
          // failed/exhausted child into a successful task.
          ...(terminalStatus === "failed" || terminalStatus === "partial"
            ? { status: "failed_with_partial_evidence" }
            : {}),
        }
      : finalResponse;

    const failure =
      terminalStatus === "failed" || terminalStatus === "partial"
        ? taskFailureDetails(finalResponse)
        : null;
    const taskResultPayload = buildTaskResult(payload.taskId, ctx.definition.role, {
      status: failure?.status ?? "completed",
      success: terminalStatus === "completed",
      result: taskResult,
      ...(failure ? { errorCode: failure.errorCode, errorMessage: failure.errorMessage } : {}),
      ...(taskEvidence
        ? {
            evidence: {
              kind: taskEvidence.kind,
              verified: taskEvidence.verified,
              detail: {
                sourceTool: taskEvidence.sourceTool,
                ...(taskEvidence.result && typeof taskEvidence.result === "object"
                  ? (taskEvidence.result as Record<string, unknown>)
                  : {}),
              },
            },
          }
        : {}),
      ...(taskSummary(finalResponse) ? { summary: taskSummary(finalResponse) } : {}),
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

    // 返回 finalResponse 供 caller（如 orchestrator_chat handler）把最终答复落库为
    // orchestrator→user 交互；其它 caller 忽略返回值即可（行为不变）。
    return { finalResponse, terminalStatus };
  } catch (err) {
    /**
     * P0-C：error 帧 + workflow_run.status='failed' + agent_instance.status='error' 现在
     * 全部由 executeAgentReact 内部统一负责。这里只保留 A2A 协议层副作用：
     *   - onWorkflowTerminal(failed)：监控/告警 hook（workflow-level）
     *   - TASK_RESULT(success=false)：A2A 上游 handler 需要的失败回执
     */
    const message = err instanceof Error ? err.message : String(err);
    if (ownsTerminalState) {
      await cancelOpenChildrenForTerminal("failed");
      onWorkflowTerminal(workflowId, "failed");
    }
    const taskResultPayload = buildTaskResult(payload.taskId, ctx.definition.role, {
      status: "failed",
      errorCode: "a2a_task_execution_error",
      result: { error: message },
      errorMessage: message,
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
    return undefined;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    clearA2ATaskCancellation(payload.taskId);
    setTimeout(() => stepStreamBus.close(runId), 250);
  }
}
