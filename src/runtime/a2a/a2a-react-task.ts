import { randomUUID } from "node:crypto";
import type { A2AMessageEnvelope, TaskAssignPayload } from "../../types/a2a";
import { stepStreamBus } from "../langgraph/event-stream";
import { executeAgentReact } from "../langgraph/execute-agent-react";
import type { AgentGraphState } from "../langgraph/state";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import type { RuntimeHandlerContext } from "../types";
import { buildTaskResult } from "./task-result";

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
  // 专家任务还有 payload.deadline 和 topology tool timeout 两层时间护栏。
  // 固定压到 5 轮会让“检查数据源 → 解析标的 → 拉数据 → 降级重试 → 总结”这类
  // 正常链路在最后总结前被 max_iterations 截断。8 轮给恢复链路留出空间，同时
  // 仍避免异常 Agent 无限循环。
  return Math.min(Math.max(1, configured), 8);
}

export async function runA2aReactTaskAssign(
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope
): Promise<
  { finalResponse: Record<string, unknown>; terminalStatus: "completed" | "failed" } | undefined
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
  const definition = ownsTerminalState
    ? ctx.definition
    : {
        ...ctx.definition,
        maxIterations: resolveA2aSpecialistMaxIterations(ctx.definition.maxIterations),
      };

  /**
   * 自研 snapshot 续跑：workflow_resume 的 payload.params.resume=true 时，
   * executeAgentReact 会按 workflowId 取最近一份 agent_checkpoint_snapshot 还原运行态
   * 并从下一轮 reason 重入（进程重启恢复 / sweep 续跑走这条线）。HITL approve 重派
   * 不带 resume —— 让 orchestrator 重跑 ReAct，由 hitlApproval 自然进入上下文。
   */
  const resume = (payload.params as Record<string, unknown> | undefined)?.resume === true;

  try {
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
    });

    /**
     * P0-3 R4：awaiting_approval 不是终态，不能调 onWorkflowTerminal —— 之前那样调
     * 会把"等审批"的工作流跑进 quality snapshot / alert 评估，污染监控指标，
     * 而且类型上 onWorkflowTerminal 只接受 completed/failed，是借 union 宽度蒙混过的。
     *
     * P0-3 R5：同理也不能发 TASK_RESULT(success=true) —— 那是个半成品消息，
     * 让上游 handler 误以为任务跑完了。awaiting_approval 时本任务挂起，等用户审批
     * 之后由 resolveHitlRequest 重新派发，此处直接 return 让本次 invocation 结束即可。
     */
    if (terminalStatus === "awaiting_approval") {
      console.log(
        `[a2a-react] workflow=${workflowId} agent=${ctx.definition.role} suspended awaiting HITL; skip TASK_RESULT / onWorkflowTerminal`
      );
      return;
    }

    if (ownsTerminalState) onWorkflowTerminal(workflowId, terminalStatus);

    const taskEvidence = ownsTerminalState
      ? null
      : extractTopologyTaskEvidence(ctx.definition.role, finalState);
    const evidenceSalvaged = taskEvidence?.verified === true;
    const taskResult = taskEvidence
      ? {
          ...finalResponse,
          taskEvidence,
          originalTerminalStatus: terminalStatus,
          ...(terminalStatus === "failed" ? { status: "completed_with_verified_evidence" } : {}),
        }
      : finalResponse;

    await ctx.send({
      workflowId,
      traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: buildTaskResult(payload.taskId, ctx.definition.role, {
        success: terminalStatus !== "failed" || evidenceSalvaged,
        result: taskResult,
      }),
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
    if (ownsTerminalState) onWorkflowTerminal(workflowId, "failed");

    await ctx.send({
      workflowId,
      traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: buildTaskResult(payload.taskId, ctx.definition.role, {
        success: false,
        result: { error: message },
        errorMessage: message,
      }),
      priority: msg.priority,
    });
    return undefined;
  } finally {
    setTimeout(() => stepStreamBus.close(runId), 250);
  }
}
