import { randomUUID } from "node:crypto";
import { a2aRouter } from "../../messaging/a2a";
import type { TaskAssignPayload } from "../../types/a2a";
import type { DispatchToLoopParams, LoopDispatchResult, LoopDriver } from "../loop/loop-driver";
import { setWorkflowState } from "../workflow/workflow-state-machine";
import { getA2APool } from "./a2a-pool";
import { createA2ATask } from "./a2a-task-service";

export function attachA2aExecutionRunId(
  payload: TaskAssignPayload,
  executionRunId: string
): TaskAssignPayload {
  const params = payload.params as Record<string, unknown>;
  const legacyGoal = params.goal ?? params.message;
  return {
    ...payload,
    ...(payload.goal || typeof legacyGoal !== "string" || !legacyGoal.trim()
      ? {}
      : { goal: legacyGoal.trim() }),
    executionRunId,
  };
}

export class A2ALoopDriver implements LoopDriver {
  readonly kind = "native" as const;

  async dispatchTask(params: DispatchToLoopParams): Promise<LoopDispatchResult> {
    const pool = getA2APool();
    if (!pool.hasRole(params.role)) {
      throw new Error(`A2A pool missing runtime for role=${params.role}`);
    }

    const receiverId = pool.getInstanceIdForRole(params.role);
    const traceId = params.traceId ?? randomUUID();
    const runId = randomUUID();
    const payload = attachA2aExecutionRunId(params.payload, runId);

    let senderId = params.senderId;
    if (!senderId) {
      try {
        senderId = pool.getInstanceIdForRole("orchestrator");
      } catch {
        senderId = receiverId;
      }
    }

    // Persist the A2A Task before publishing its delivery envelope.  The local
    // EventEmitter remains a transport adapter; workflow recovery and task
    // waiting use this durable Task projection as their source of truth.
    await createA2ATask({
      workflowId: params.workflowId,
      traceId,
      senderAgentId: senderId,
      receiverAgentId: receiverId,
      receiverRole: params.role,
      payload,
    });

    await a2aRouter.send({
      workflowId: params.workflowId,
      traceId,
      senderAgent: senderId,
      receiverAgent: receiverId,
      messageType: "TASK_ASSIGN",
      payload,
      priority: 50,
    });

    await setWorkflowState(params.workflowId, "running", { reason: "a2a-loop-driver:dispatch" });

    return { runId, receiverId, senderId, traceId };
  }
}

export const a2aLoopDriver = new A2ALoopDriver();
