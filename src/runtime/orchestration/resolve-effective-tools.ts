import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { researchScenarioRegistry } from "../research-scenario/registry";
import { resolveRegistryScenarioKey } from "../research-scenario/scenario-key-aliases";
import { resolveToolAlias } from "../tools/tool-catalog";
import type { RuntimeAgentDefinition } from "../types";
import {
  applyMissingArtifactToolFilter,
  applyStallToolFilter,
  applyToolSurface,
  ensureFactsPort,
  getWorkflowFactsPort,
} from "../policy";
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
  scenarioTools: string[];
  scenarioKey: string | null;
};

const ORCHESTRATOR_COMPAT_TEAM_TOOLS = new Set([
  "run_analyst_team",
  "summarize_team_decision",
  "fuse_signals",
]);

const SCENARIO_SUPPORT_TOOLS = new Set(["update_plan"]);
const MARKET_GOVERNANCE_TOOLS = [
  "market.resolve_symbol",
  "market.data_sources",
  "market.readiness",
] as const;
const MARKET_DATA_TOOLS = new Set([
  "fetch_klines",
  "fetch_price_data",
  "fetch_financial_data",
  "fetch_ticks",
  ...MARKET_GOVERNANCE_TOOLS,
]);

function normalizeToolNames(names: string[]): string[] {
  return [...new Set(names.map((n) => resolveToolAlias(n.trim()).resolved).filter(Boolean))];
}

export function attachMarketGovernanceTools(role: string, tools: string[]): string[] {
  return role === "orchestrator" || tools.some((tool) => MARKET_DATA_TOOLS.has(tool))
    ? normalizeToolNames([...tools, ...MARKET_GOVERNANCE_TOOLS])
    : tools;
}

/**
 * CapabilityGate answers "what is authorized"; ToolSurface answers "what is
 * useful now".  Reasoning must see their intersection, otherwise the model
 * keeps proposing authorized-but-currently-disallowed probe tools and Act has
 * to reject them one turn later.
 */
export function intersectCapabilityWithEffectiveTools(
  capabilityTools: readonly string[],
  effectiveTools: readonly string[]
): string[] {
  const effective = new Set<string>();
  for (const name of effectiveTools) {
    const normalized = resolveToolAlias(name.trim()).resolved;
    if (!normalized) continue;
    effective.add(normalized);
    effective.add(toolBaseName(normalized));
  }
  return capabilityTools.filter((name) => {
    const normalized = resolveToolAlias(name.trim()).resolved;
    return effective.has(normalized) || effective.has(toolBaseName(normalized));
  });
}

function toolBaseName(name: string): string {
  if (!name.includes("/")) return name;
  const parts = name.split("/");
  return parts[parts.length - 1] ?? name;
}

/** Re-export policy filters so existing tests keep importing from orchestration. */
export { applyStallToolFilter, applyMissingArtifactToolFilter };

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
  const requested = (rows[0]?.researchScenarioId ?? "").trim();
  if (!requested) return { scenarioKey: null, tools: [] };
  const registryKey = resolveRegistryScenarioKey(requested) ?? requested;
  const spec = researchScenarioRegistry.get(registryKey);
  if (!spec) return { scenarioKey: requested, tools: [] };
  const preset = spec.toolPreset?.builtinTools ?? [];
  return { scenarioKey: requested, tools: normalizeToolNames(preset) };
}

export function filterScenarioToolsForContractProgress(input: {
  tools: readonly string[];
  scenarioKey: string | null;
  workflowId: string;
  role?: string;
}): string[] {
  const { scenarioKey, workflowId } = input;
  if (!scenarioKey) return [...input.tools];
  try {
    const port = getWorkflowFactsPort();
    const snapshot = port.loadSnapshot(workflowId, {
      availableTools: input.tools,
      includeA2a: true,
    });
    return applyToolSurface({
      tools: input.tools,
      snapshot: { ...snapshot, scenarioKey: snapshot.scenarioKey ?? scenarioKey },
      ...(input.role ? { role: input.role } : {}),
    });
  } catch {
    return [...input.tools];
  }
}

export async function resolveEffectiveAgentTools(
  def: RuntimeAgentDefinition,
  workflowId: string
): Promise<EffectiveToolsResult> {
  await ensureFactsPort();
  const { scenarioKey, tools: scenarioTools } = await loadScenarioToolsForWorkflow(workflowId);

  const scenarioScopedTools =
    scenarioKey && scenarioTools.length > 0
      ? normalizeToolNames([...scenarioTools, ...SCENARIO_SUPPORT_TOOLS])
      : [];

  /**
   * A scenario preset describes the workflow-level contract, not a specialist
   * capability whitelist.  Applying it as the only surface for every analyst
   * made a global progress fact (for example, another analyst already fetched
   * price) narrow a fundamental specialist to `fetch_news`, which it is not
   * authorized to run.  The prompt then had enabled MCP servers but zero
   * callable tools, so the model's valid `call_mcp` action was rejected.
   *
   * Keep the preset strict for the orchestrator, which owns contract progress.
   * Specialists instead begin with their declared, sandbox-governed tool set;
   * the same progress filter may prioritize a next action but cannot invent a
   * capability they do not own.
   */
  const specialistDeclaredTools = normalizeToolNames([...(def.tools ?? []), "web.fetch"]);
  const baseRaw =
    scenarioScopedTools.length && def.role === "orchestrator"
      ? scenarioScopedTools
      : scenarioScopedTools.length
        ? specialistDeclaredTools
        : normalizeToolNames([...(def.tools ?? []), ...scenarioTools, "web.fetch"]);

  const base = scenarioScopedTools.length
    ? filterScenarioToolsForContractProgress({
        tools: baseRaw,
        scenarioKey,
        workflowId,
        role: def.role,
      })
    : attachMarketGovernanceTools(def.role, baseRaw);

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

  if (scenarioScopedTools.length > 0) {
    return {
      tools: base,
      topologyContext: null,
      topologyPromptBlock: "",
      collaborationHint: "",
      scenarioTools,
      scenarioKey,
    };
  }

  const topologyContext = await loadOrchestratorTopologyForWorkflow();
  const topologyTools = topologyContext?.toolNames ?? [];
  const tools = normalizeToolNames(
    [...base, ...topologyTools, "update_plan"].filter(
      (toolName) => !ORCHESTRATOR_COMPAT_TEAM_TOOLS.has(toolName)
    )
  );
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
