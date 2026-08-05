/**
 * Seed → Core AgentSpec migration.
 * Legacy `role` becomes labels; ExecutionKind is the only Core branch key.
 * Specs for live Core sync prefer DB definitions (UI publish path).
 */

import { getDb } from "../../db/sqlite/client";
import { agentDefinition } from "../../db/sqlite/schema";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";
import type { AgentOutput, RuntimeAgentDefinition } from "../types";
import { resolveExecutionKind } from "./execution-kind";
import { defaultRecipeForRole } from "./role-to-execution-kind";
import type { AgentSpec, ExecutionKind } from "./types";

export function toPrimeAgentSpec(def: RuntimeAgentDefinition): AgentSpec {
  const kind: ExecutionKind = resolveExecutionKind({
    executionKind: def.executionKind,
    role: def.role,
  });
  const triggers =
    kind === "reactor"
      ? ([{ kind: "domain_event" as const, event_name: "market.news" }] as AgentSpec["triggers"])
      : [];

  return {
    id: def.id,
    version: def.version,
    display_name: def.name,
    execution_kind: kind,
    labels: [def.role, ...(def.outputs ?? [])],
    identity_prompt_ref: `seed://${def.id}`,
    system_prompt: def.systemPrompt?.trim() || null,
    default_recipe_id: defaultRecipeForRole(def.role),
    tool_surface_ref: `tools://${def.id}`,
    model_ref: def.llmProvider || null,
    max_iterations: def.maxIterations,
    hitl_profile_ref: null,
    allowed_callers: [],
    triggers,
    enabled: def.enabled,
  };
}

/** Builtin seeds projected into Core AgentSpec (tests / offline). */
export function buildPrimeAgentSpecs(
  defs: RuntimeAgentDefinition[] = SEED_AGENT_DEFINITIONS
): AgentSpec[] {
  return defs.map(toPrimeAgentSpec);
}

function mapDbRowToRuntimeDef(d: typeof agentDefinition.$inferSelect): RuntimeAgentDefinition {
  const outputsRaw = d.outputsJson;
  const outputs = Array.isArray(outputsRaw)
    ? (outputsRaw.filter((x): x is AgentOutput => typeof x === "string") as AgentOutput[])
    : [];
  return {
    id: d.id,
    role: d.role,
    executionKind: resolveExecutionKind({
      executionKind: d.executionKind,
      role: d.role,
    }),
    name: d.name,
    version: d.version,
    systemPrompt: d.systemPrompt,
    tools: Array.isArray(d.toolsJson) ? (d.toolsJson as string[]) : [],
    mcpServers: Array.isArray(d.mcpServersJson) ? (d.mcpServersJson as string[]) : [],
    skills: Array.isArray(d.skillsJson) ? (d.skillsJson as string[]) : [],
    subscriptions: (Array.isArray(d.subscriptionsJson)
      ? d.subscriptionsJson
      : ["TASK_ASSIGN"]) as RuntimeAgentDefinition["subscriptions"],
    llmProvider: d.llmProvider,
    ...(outputs.length > 0 ? { outputs } : {}),
    maxIterations: d.maxIterations,
    sandboxPolicyId: d.sandboxPolicyId,
    enabled: Boolean(d.enabled),
  };
}

/**
 * Load agent_definition rows as RuntimeAgentDefinition.
 * Empty DB falls back to SEED so Core attach still works before seed finishes.
 */
export async function loadRuntimeAgentDefinitionsFromDb(): Promise<RuntimeAgentDefinition[]> {
  const db = await getDb();
  const rows = await db.select().from(agentDefinition);
  if (rows.length === 0) return SEED_AGENT_DEFINITIONS;
  return rows.map(mapDbRowToRuntimeDef);
}

/** Live Core sync source: DB definitions → AgentSpec[]. */
export async function buildPrimeAgentSpecsFromDb(): Promise<AgentSpec[]> {
  const defs = await loadRuntimeAgentDefinitionsFromDb();
  return buildPrimeAgentSpecs(defs);
}

export function primePrimarySpecId(
  specs: AgentSpec[] = buildPrimeAgentSpecs()
): string {
  const primary = specs.find((s) => s.execution_kind === "primary" && s.enabled);
  return primary?.id ?? "def-orchestrator";
}

export function summarizePrimeSeed(specs: AgentSpec[] = buildPrimeAgentSpecs()) {
  const byKind = { primary: 0, subagent: 0, reactor: 0 };
  for (const s of specs) {
    byKind[s.execution_kind] += 1;
  }
  return { total: specs.length, byKind, primaryId: primePrimarySpecId(specs) };
}
