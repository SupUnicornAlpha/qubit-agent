/**
 * agent.invoke via Core + project topology edge into research_team_interaction.
 */

import { getCoreRuntime } from "./core-runtime";
import { projectCoreInvocation } from "./project-core-to-graph";

export type InvokeAgentAndProjectInput = {
  workflowRunId: string;
  runId?: string;
  traceId?: string;
  callerRole?: string;
  calleeLabel?: string;
  request: {
    invocation_id: string;
    parent_session_id: string;
    parent_turn_id: string;
    caller_instance_id: string;
    callee_spec_id: string;
    goal: string;
    budget?: { max_iterations?: number };
    handoff_in?: unknown;
    deadline_ms?: number;
  };
};

export async function invokeAgentAndProject(
  input: InvokeAgentAndProjectInput
): Promise<Record<string, unknown>> {
  const core = getCoreRuntime();
  const req = {
    ...input.request,
    budget: {
      max_iterations: input.request.budget?.max_iterations ?? 8,
      ...input.request.budget,
    },
  };
  const record = await core.invokeAgent(req);
  const state = typeof record.state === "string" ? record.state : undefined;
  const delivery =
    record.delivery && typeof record.delivery === "object"
      ? (record.delivery as { status?: string })
      : undefined;
  await projectCoreInvocation({
    workflowRunId: input.workflowRunId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
    callerRole: input.callerRole,
    calleeSpecId: input.request.callee_spec_id,
    calleeLabel: input.calleeLabel,
    goal: input.request.goal,
    invocationId: input.request.invocation_id,
    childSessionId:
      typeof record.child_session_id === "string" ? record.child_session_id : undefined,
    childTurnId: typeof record.child_turn_id === "string" ? record.child_turn_id : undefined,
    state,
    deliveryStatus: delivery?.status,
  });
  return record;
}
