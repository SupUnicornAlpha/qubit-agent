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
  // Coding-Agent 体验 P1：update_plan 是编排器通用的「计划/TODO」元工具，始终注入，
  // 无需依赖 agent_definition.tools 是否声明（避免再 seed 一遍 DB）。
  const tools = [...new Set([...base, ...topologyTools, "update_plan"])];
  const topologyPromptBlock = buildTopologyToolsPromptBlock(topologyContext);

  return {
    tools,
    topologyContext,
    topologyPromptBlock,
    collaborationHint: "",
  };
}
