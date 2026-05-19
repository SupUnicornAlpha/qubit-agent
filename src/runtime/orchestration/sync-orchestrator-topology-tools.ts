import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition } from "../../db/sqlite/schema";
import { loadOrchestratorTopologyForGroup, mergeOrchestratorToolsJson } from "./topology-dispatch";

const ORCHESTRATOR_DEFINITION_ID = "def-orchestrator";

/**
 * 根据编组拓扑出边，将 `call_team_<role>` 写入 Orchestrator 的 toolsJson（配置中心可见）。
 */
export async function syncOrchestratorTopologyToolsForGroup(groupId: string): Promise<{
  topologyTools: string[];
  toolsJson: string[];
}> {
  const ctx = await loadOrchestratorTopologyForGroup(groupId);
  const topologyTools = ctx?.toolNames ?? [];
  const canonical = mergeOrchestratorToolsJson(topologyTools);

  const db = await getDb();
  await db
    .update(agentDefinition)
    .set({
      toolsJson: canonical,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentDefinition.id, ORCHESTRATOR_DEFINITION_ID));

  return { topologyTools, toolsJson: canonical };
}
