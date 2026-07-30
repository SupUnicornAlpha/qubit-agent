import type { AgentGraphState } from "../state";
import { createEmptyWorkingMemory, ensureWorkingMemory } from "../../context/working-memory";

export async function perceiveNode(state: AgentGraphState): Promise<Partial<AgentGraphState>> {
  const memoryContext = {
    workflowGoal: state.inboundMessage.payload,
    role: state.agentDefinition.role,
    receivedAt: new Date().toISOString(),
  };

  return {
    contextMemory: memoryContext,
    workingMemory: ensureWorkingMemory(state.workingMemory) ?? createEmptyWorkingMemory(),
  };
}

