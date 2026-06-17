import { randomUUID } from "node:crypto";
import type { A2AMessageEnvelope, TaskAssignPayload } from "../../types/a2a";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { executeAgentReact } from "../langgraph/execute-agent-react";
import { stepStreamBus } from "../langgraph/event-stream";
import type { RuntimeHandlerContext } from "../types";
import { buildTaskResult } from "./task-result";

/**
 * Run the shared ReAct loop for an A2A TASK_ASSIGN, then reply with TASK_RESULT.
 */
export async function runA2aReactTaskAssign(
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope
): Promise<
  { finalResponse: Record<string, unknown>; terminalStatus: "completed" | "failed" } | undefined
> {
  const payload = msg.payload as TaskAssignPayload;
  const runId = randomUUID();
  const traceId = msg.traceId;
  const workflowId = msg.workflowId;

  /**
   * 自研 snapshot 续跑：workflow_resume 的 payload.params.resume=true 时，
   * executeAgentReact 会按 workflowId 取最近一份 agent_checkpoint_snapshot 还原运行态
   * 并从下一轮 reason 重入（进程重启恢复 / sweep 续跑走这条线）。HITL approve 重派
   * 不带 resume —— 让 orchestrator 重跑 ReAct，由 hitlApproval 自然进入上下文。
   */
  const resume = (payload.params as Record<string, unknown> | undefined)?.resume === true;

  try {
    const { finalResponse, terminalStatus } = await executeAgentReact({
      runId,
      workflowId,
      traceId,
      def: ctx.definition,
      payload,
      receiverAgent: ctx.instance.instanceId,
      streamLoopKind: "native",
      streamSource: "a2a",
      updateWorkflowStatus: true,
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

    onWorkflowTerminal(workflowId, terminalStatus);

    await ctx.send({
      workflowId,
      traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: buildTaskResult(payload.taskId, ctx.definition.role, {
        success: terminalStatus !== "failed",
        result: finalResponse,
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
    onWorkflowTerminal(workflowId, "failed");

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
  } finally {
    setTimeout(() => stepStreamBus.close(runId), 250);
  }
}
