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
): Promise<void> {
  const payload = msg.payload as TaskAssignPayload;
  const runId = randomUUID();
  const traceId = msg.traceId;
  const workflowId = msg.workflowId;

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
    });
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stepStreamBus.publish({
      runId,
      workflowId,
      traceId,
      role: ctx.definition.role,
      type: "error",
      stepIndex: 0,
      ts: Date.now(),
      payload: { error: message },
      loopKind: "native",
      source: "a2a",
    });
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
