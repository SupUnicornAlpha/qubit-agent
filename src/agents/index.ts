import type { TaskAssignPayload } from "../types/a2a";
import type { AgentRole } from "../types/entities";
import { graphRunner } from "../runtime/langgraph/graph-factory";

export function getRuntimeAgents() {
  return graphRunner.getViews();
}

export async function startAllAgents(): Promise<void> {
  await graphRunner.start();
  console.log(`[AgentPool] GraphRunner bootstrapped ${graphRunner.getViews().length} roles.`);
}

export async function stopAllAgents(): Promise<void> {
  await graphRunner.stop();
  console.log("[AgentPool] GraphRunner stopped.");
}

export async function dispatchTaskToRole(params: {
  workflowId: string;
  role: AgentRole;
  payload: TaskAssignPayload;
  traceId?: string;
  senderId?: string;
}): Promise<{ runId: string }> {
  return graphRunner.runRoleTask({
    workflowId: params.workflowId,
    role: params.role,
    payload: params.payload,
    traceId: params.traceId,
  });
}
