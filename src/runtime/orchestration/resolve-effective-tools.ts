import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { appendHarnessCompositionSafe, appendHarnessEventSafe } from "../harness/event-ledger";
import {
  type HarnessResolverRollout,
  resolveHarnessResolverRolloutFromEnv,
} from "../harness/rollout";
import {
  type HarnessToolSurfaceShadow,
  buildHarnessToolSurfaceShadow,
} from "../harness/shadow-tool-surface";
import { stripOrchestratorTeamCompatTools } from "../market/contracts/prime-tool-host-surface";
import {
  applyMissingArtifactToolFilter,
  applyStallToolFilter,
  applyToolSurface,
  ensureFactsPort,
  getWorkflowFactsPort,
} from "../policy";
import { researchScenarioRegistry } from "../research-scenario/registry";
import { resolveRegistryScenarioKey } from "../research-scenario/scenario-key-aliases";
import { resolveToolAlias } from "../tools/tool-catalog";
import type { RuntimeAgentDefinition } from "../types";
import {
  type OrchestratorTopologyContext,
  buildAgentCollaborationHint,
  buildTopologyToolsPromptBlock,
  loadOrchestratorTopologyForWorkflow,
} from "./topology-dispatch";

export type EffectiveToolsResult = {
  tools: string[];
  /**
   * Phase 2 shadow-only Harness surface. It is deliberately observational:
   * prompt and execution continue to use `tools` until an explicit rollout.
   */
  harnessShadow: HarnessToolSurfaceShadow;
  /** Shadow by default; becomes active only for an explicit profile allowlist. */
  harnessRollout: HarnessResolverRollout;
  topologyContext: OrchestratorTopologyContext | null;
  topologyPromptBlock: string;
  collaborationHint: string;
  scenarioTools: string[];
  scenarioKey: string | null;
};

async function withHarnessShadow(
  definition: RuntimeAgentDefinition,
  workflowId: string,
  result: Omit<EffectiveToolsResult, "harnessShadow" | "harnessRollout">
): Promise<EffectiveToolsResult> {
  const harnessShadow = buildHarnessToolSurfaceShadow({
    role: definition.role,
    legacyTools: result.tools,
  });
  const harnessRollout = resolveHarnessResolverRolloutFromEnv(harnessShadow);
  await appendHarnessCompositionSafe({
    workflowRunId: workflowId,
    mode: harnessRollout.mode,
    profileIds: harnessShadow.profileIds,
    capabilityIds: harnessShadow.capabilityIds,
    sharedTools: harnessShadow.sharedTools,
    legacyOnlyTools: harnessShadow.legacyOnlyTools,
    harnessOnlyTools: harnessShadow.harnessOnlyTools,
  });
  if (harnessShadow.unavailableProfileIds.length > 0) {
    await appendHarnessEventSafe({
      workflowRunId: workflowId,
      eventType: "capability.degraded",
      profileId: harnessShadow.unavailableProfileIds.join("+"),
      payload: {
        reason: harnessShadow.availabilityWarning,
        unavailableProfileIds: harnessShadow.unavailableProfileIds,
        fallbackProfileIds: harnessShadow.profileIds,
        // The old tool surface remains the availability fallback.
        legacyToolCount: harnessShadow.legacyTools.length,
      },
    });
  }
  return {
    ...result,
    tools: harnessRollout.effectiveTools,
    harnessShadow,
    harnessRollout,
  };
}

const SCENARIO_SUPPORT_TOOLS = new Set(["update_plan"]);

/** Research-default internet builtins; always attached outside strict orchestrator scenario presets. */
const INTERNET_SUPPORT_TOOLS = ["web.fetch", "web.search"] as const;
/**
 * Orchestrator may inspect the user's IDE subscription and make an explicit
 * broker read; it must not infer either from conversational memory.
 */
const ORCHESTRATOR_PRIME_MARKET_TOOLS = [
  "market.ide_subscription.get",
  "market.broker_quote.get",
  "market.resolve_symbol",
  "market.snapshot.get",
] as const;
const MARKET_GOVERNANCE_TOOLS = [
  "market.ide_subscription.get",
  "market.broker_quote.get",
  "market.resolve_symbol",
  "market.data_sources",
  "market.readiness",
  "market.snapshot.get",
] as const;
const MARKET_DATA_TOOLS = new Set([
  "fetch_klines",
  "fetch_fundamentals",
  "fetch_ticks",
  "fetch_quote",
  "fetch_option_chain",
  "market.snapshot.get",
  ...MARKET_GOVERNANCE_TOOLS,
]);

function normalizeToolNames(names: string[]): string[] {
  return [...new Set(names.map((n) => resolveToolAlias(n.trim()).resolved).filter(Boolean))];
}

export function attachMarketGovernanceTools(role: string, tools: string[]): string[] {
  if (role === "orchestrator") {
    return normalizeToolNames([...tools, ...ORCHESTRATOR_PRIME_MARKET_TOOLS]);
  }
  return tools.some((tool) => MARKET_DATA_TOOLS.has(tool))
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
   * callable tools, so the model's valid typed `mcp:<server>:<tool>` action was rejected.
   *
   * Keep the preset strict for the orchestrator, which owns contract progress.
   * Specialists instead begin with their declared, sandbox-governed tool set;
   * the same progress filter may prioritize a next action but cannot invent a
   * capability they do not own.
   */
  const specialistDeclaredTools = normalizeToolNames([
    ...(def.tools ?? []),
    ...INTERNET_SUPPORT_TOOLS,
  ]);
  const baseRaw =
    scenarioScopedTools.length && def.role === "orchestrator"
      ? // Orchestrator owns scenario contract progress, but must keep research-default internet.
        normalizeToolNames([...scenarioScopedTools, ...INTERNET_SUPPORT_TOOLS])
      : scenarioScopedTools.length
        ? specialistDeclaredTools
        : normalizeToolNames([...(def.tools ?? []), ...scenarioTools, ...INTERNET_SUPPORT_TOOLS]);

  const base = scenarioScopedTools.length
    ? normalizeToolNames([
        ...filterScenarioToolsForContractProgress({
          tools: baseRaw,
          scenarioKey,
          workflowId,
          role: def.role,
        }),
        // User-level “my watchlist” remains callable under every scenario;
        // otherwise a scenario preset can make the Agent fall back to memory.
        ...(def.role === "orchestrator" ? ORCHESTRATOR_PRIME_MARKET_TOOLS : []),
      ])
    : attachMarketGovernanceTools(def.role, baseRaw);

  if (def.role !== "orchestrator") {
    return withHarnessShadow(def, workflowId, {
      tools: base,
      topologyContext: null,
      topologyPromptBlock: "",
      collaborationHint: buildAgentCollaborationHint(def.role),
      scenarioTools,
      scenarioKey,
    });
  }

  // Prime D6: strip team-compat bulk tools on every orchestrator path (incl. scenario).
  if (scenarioScopedTools.length > 0) {
    return withHarnessShadow(def, workflowId, {
      tools: stripOrchestratorTeamCompatTools(base),
      topologyContext: null,
      topologyPromptBlock: "",
      collaborationHint: "",
      scenarioTools,
      scenarioKey,
    });
  }

  const topologyContext = await loadOrchestratorTopologyForWorkflow();
  const topologyTools = topologyContext?.toolNames ?? [];
  const tools = stripOrchestratorTeamCompatTools(
    normalizeToolNames([...base, ...topologyTools, "update_plan"])
  );
  const topologyPromptBlock = buildTopologyToolsPromptBlock(topologyContext);

  return withHarnessShadow(def, workflowId, {
    tools,
    topologyContext,
    topologyPromptBlock,
    collaborationHint: "",
    scenarioTools,
    scenarioKey,
  });
}
