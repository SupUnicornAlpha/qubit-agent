import { getDb } from "../../../db/sqlite/client";
import { agentStep } from "../../../db/sqlite/schema";
import type { AgentGraphState, StepStreamEvent } from "../state";

export async function observeNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string
): Promise<Partial<AgentGraphState>> {
  const db = await getDb();
  const stepId = crypto.randomUUID();
  const observation = {
    iteration: state.iteration,
    toolCalls: state.toolCalls.slice(-1),
    reasonText: state.reasonText,
  };

  await db.insert(agentStep).values({
    id: stepId,
    agentInstanceId,
    workflowRunId: state.workflowId,
    stepIndex: state.iteration,
    phase: "observe",
    thought: state.reasonText,
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

