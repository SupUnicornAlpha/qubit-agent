import type { AgentRole } from "../../types/entities";
import type { RuntimeAgentDefinition } from "../types";
import {
  buildAgentCollaborationHint,
  buildTopologyToolsPromptBlock,
  loadOrchestratorTopologyForWorkflow,
  type OrchestratorTopologyContext,
} from "./topology-dispatch";

export type EffectiveToolsResult = {
  tools: string[];
  topologyContext: OrchestratorTopologyContext | null;
  topologyPromptBlock: string;
  collaborationHint: string;
};

export async function resolveEffectiveAgentTools(
  def: RuntimeAgentDefinition,
  workflowId: string
): Promise<EffectiveToolsResult> {
  const base = def.tools ?? [];
  if (def.role !== "orchestrator") {
    return {
      tools: base,
      topologyContext: null,
      topologyPromptBlock: "",
      collaborationHint: buildAgentCollaborationHint(def.role),
    };
  }

  const topologyContext = await loadOrchestratorTopologyForWorkflow(workflowId);
  const topologyTools = topologyContext?.toolNames ?? [];
  const tools = [...new Set([...base, ...topologyTools])];
  const topologyPromptBlock = buildTopologyToolsPromptBlock(topologyContext);

  return {
    tools,
    topologyContext,
    topologyPromptBlock,
    collaborationHint: "",
  };
}
