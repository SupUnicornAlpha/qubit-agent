import { getDb } from "../../../db/sqlite/client";
import { agentStep } from "../../../db/sqlite/schema";
import type { AgentGraphState, StepStreamEvent } from "../state";
import { stripToolCallSentinels } from "../../tools/tool-call-format";

export async function observeNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string
): Promise<Partial<AgentGraphState>> {
  const db = await getDb();
  const stepId = crypto.randomUUID();
  /** 持久化与广播给前端的 reasonText 都剥掉 sentinel 块，避免泄漏到 UI / 审计 */
  const displayReasonText = stripToolCallSentinels(state.reasonText);
  const observation = {
    iteration: state.iteration,
    toolCalls: state.toolCalls.slice(-1),
    reasonText: displayReasonText,
  };

  await db.insert(agentStep).values({
    id: stepId,
    agentInstanceId,
    workflowRunId: state.workflowId,
    stepIndex: state.iteration,
    phase: "observe",
    thought: displayReasonText,
    actionType: "tool_call",
    actionJson: { plannedAction: state.plannedAction },
    observationJson: observation,
    tokenCount: state.reasonText?.split(/\s+/).filter(Boolean).length ?? 0,
    latencyMs: 1,
  });

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "observe",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: observation,
  });

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "step_persisted",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: { stepId, phase: "observe" },
  });

  return {
    observations: [...state.observations, observation],
  };
}

