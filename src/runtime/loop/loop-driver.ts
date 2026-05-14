import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import type { AgentLoopKind } from "../../types/loop";

export interface DispatchToLoopParams {
  workflowId: string;
  role: AgentRole;
  payload: TaskAssignPayload;
  traceId?: string;
}

/**
 * Pluggable agent execution loop (Native LangGraph vs external CLI).
 */
export interface LoopDriver {
  readonly kind: AgentLoopKind;
  dispatchTask(params: DispatchToLoopParams): Promise<{ runId: string }>;
}
