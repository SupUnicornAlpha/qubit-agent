import { getDb } from "../../../db/sqlite/client";
import { acpCall, toolCallLog } from "../../../db/sqlite/schema";
import { eq } from "drizzle-orm";
import { sandboxExecutor } from "../../sandbox-executor";
import type { AgentGraphState, StepStreamEvent } from "../state";

export async function actNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string,
  agentStepId: string
): Promise<Partial<AgentGraphState>> {
  const toolName = state.agentDefinition.tools[0] ?? "noop_tool";
  const toolCallId = crypto.randomUUID();
  const db = await getDb();

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "tool_call_start",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: { toolCallId, toolName },
  });

  await db.insert(toolCallLog).values({
    id: toolCallId,
    agentStepId,
    toolName,
    toolKind: "builtin",
    requestJson: {
      reasonText: state.reasonText,
      contextMemory: state.contextMemory,
    },
    status: "success",
    latencyMs: 1,
  });

  const check = await sandboxExecutor.checkToolCall({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    agentInstanceId,
    toolName,
    payload: { plannedAction: state.plannedAction ?? "unknown" },
    definition: state.agentDefinition,
  });

  if (!check.allowed) {
    const acpId = crypto.randomUUID();
    await db.insert(acpCall).values({
      id: acpId,
      workflowRunId: state.workflowId,
      traceId: state.traceId,
      agentStepId,
      callerInstanceId: agentInstanceId,
      targetKind: "tool",
      targetName: toolName,
      intent: state.plannedAction ?? "tool_call",
      status: "blocked_by_sandbox",
      errorCode: check.violationType ?? "tool_not_allowed",
    });

    await db
      .update(toolCallLog)
      .set({
        status: "sandbox_blocked",
        errorMessage: check.reason ?? "blocked by sandbox",
      })
      .where(eq(toolCallLog.id, toolCallId));

    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "tool_call_end",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { toolCallId, status: "blocked_by_sandbox", reason: check.reason },
    });
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: {
        level: "error",
        sandbox: true,
        acpId,
        reason: check.reason ?? "sandbox denied tool call",
      },
    });

    return {
      toolCalls: [
        ...state.toolCalls,
        { toolCallId, toolName, status: "blocked_by_sandbox", reason: check.reason },
      ],
      observations: [
        ...state.observations,
        { level: "error", message: check.reason ?? "sandbox denied tool call" },
      ],
    };
  }

  const startedAt = Date.now();
  const execution = await sandboxExecutor.enforceToolTimeout({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    agentInstanceId,
    definition: state.agentDefinition,
    action: async () => {
      await Bun.sleep(1);
      return { result: "ok" as const };
    },
    meta: { toolName },
  });

  if (!execution.ok) {
    const latencyMs = Date.now() - startedAt;
    const timeoutAcpId = crypto.randomUUID();
    await db.insert(acpCall).values({
      id: timeoutAcpId,
      workflowRunId: state.workflowId,
      traceId: state.traceId,
      agentStepId,
      callerInstanceId: agentInstanceId,
      targetKind: "tool",
      targetName: toolName,
      intent: state.plannedAction ?? "tool_call",
      status: "timeout",
      latencyMs,
      errorCode: execution.result.violationType ?? "timeout",
    });
    await db
      .update(toolCallLog)
      .set({
        status: "timeout",
        latencyMs,
        errorMessage: execution.result.reason ?? "tool timeout",
      })
      .where(eq(toolCallLog.id, toolCallId));
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "tool_call_end",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { toolCallId, status: "timeout", reason: execution.result.reason },
    });
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { level: "error", timeout: true, reason: execution.result.reason },
    });
    return {
      toolCalls: [
        ...state.toolCalls,
        { toolCallId, toolName, status: "timeout", reason: execution.result.reason },
      ],
      observations: [
        ...state.observations,
        { level: "error", message: execution.result.reason ?? "tool timeout" },
      ],
    };
  }

  const latencyMs = Date.now() - startedAt;
  const acpId = crypto.randomUUID();
  await db.insert(acpCall).values({
    id: acpId,
    workflowRunId: state.workflowId,
    traceId: state.traceId,
    agentStepId,
    callerInstanceId: agentInstanceId,
    targetKind: "tool",
    targetName: toolName,
    intent: state.plannedAction ?? "tool_call",
    status: "success",
    latencyMs,
  });

  await db
    .update(toolCallLog)
    .set({
      status: "success",
      latencyMs,
      responseJson: { ...execution.value, acpId },
    })
    .where(eq(toolCallLog.id, toolCallId));

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "tool_call_end",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: { toolCallId, status: "success", acpId },
  });

  return {
    toolCalls: [...state.toolCalls, { toolCallId, toolName, status: "success", acpId }],
  };
}

