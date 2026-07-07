import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { researchScenarioRegistry } from "../research-scenario/registry";
import { resolveToolAlias } from "../tools/tool-catalog";
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
  /** 来自 research_scenario.toolPreset.builtinTools（已 alias 规范化） */
  scenarioTools: string[];
  scenarioKey: string | null;
};

function normalizeToolNames(names: string[]): string[] {
  return [...new Set(names.map((n) => resolveToolAlias(n.trim()).resolved).filter(Boolean))];
}

async function loadScenarioToolsForWorkflow(workflowId: string): Promise<{
  scenarioKey: string | null;
  tools: string[];
}> {
  const db = await getDb();
  const rows = await db
    .select({ researchScenarioId: workflowRun.researchScenarioId })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  const key = (rows[0]?.researchScenarioId ?? "").trim();
  if (!key) return { scenarioKey: null, tools: [] };
  const spec = researchScenarioRegistry.get(key);
  if (!spec) return { scenarioKey: key, tools: [] };
  const preset = spec.toolPreset?.builtinTools ?? [];
  return { scenarioKey: key, tools: normalizeToolNames(preset) };
}

export async function resolveEffectiveAgentTools(
  def: RuntimeAgentDefinition,
  workflowId: string
): Promise<EffectiveToolsResult> {
  const { scenarioKey, tools: scenarioTools } = await loadScenarioToolsForWorkflow(workflowId);

  // Coding-Agent 体验 P2：web.fetch 对所有角色始终可用。
  // Runtime 4.5：scenario toolPreset 与 agent_definition.tools 合并（alias 规范化）。
  const base = normalizeToolNames([
    ...(def.tools ?? []),
    ...scenarioTools,
    "web.fetch",
  ]);

  if (def.role !== "orchestrator") {
    return {
      tools: base,
      topologyContext: null,
      topologyPromptBlock: "",
      collaborationHint: buildAgentCollaborationHint(def.role),
      scenarioTools,
      scenarioKey,
    };
  }

  const topologyContext = await loadOrchestratorTopologyForWorkflow(workflowId);
  const topologyTools = topologyContext?.toolNames ?? [];
  const tools = normalizeToolNames([...base, ...topologyTools, "update_plan"]);
  const topologyPromptBlock = buildTopologyToolsPromptBlock(topologyContext);

  return {
    tools,
    topologyContext,
    topologyPromptBlock,
    collaborationHint: "",
    scenarioTools,
    scenarioKey,
  };
}
