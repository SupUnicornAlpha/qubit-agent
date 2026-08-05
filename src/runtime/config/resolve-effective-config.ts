/**
 * Effective agent definitions: JSON (`.qubit/agents.json`) as source of truth,
 * with per-field DB `user_overrides_json` patches applied on top.
 *
 * `syncWorkspaceConfigToDb` remains the projection path (JSON → DB for non-overridden fields).
 */
import { getDb } from "../../db/sqlite/client";
import { agentDefinition } from "../../db/sqlite/schema";
import { parseUserOverrides } from "../agent/agent-binding-service";
import { parseLlmConfigJson } from "../llm/agent-llm-config";
import { resolveExecutionKind } from "../prime/execution-kind";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";
import type { AgentOutput, RuntimeAgentDefinition } from "../types";
import { loadWorkspaceRuntimeConfig } from "./workspace-config";

type AgentDefinitionRow = typeof agentDefinition.$inferSelect;

function applyDbOverrides(
  base: RuntimeAgentDefinition,
  row: AgentDefinitionRow | undefined
): RuntimeAgentDefinition {
  if (!row) {
    return {
      ...base,
      executionKind: resolveExecutionKind({
        executionKind: base.executionKind,
        role: base.role,
      }),
    };
  }

  const overrides = parseUserOverrides(row.userOverridesJson);
  const out: RuntimeAgentDefinition = {
    ...base,
    executionKind: resolveExecutionKind({
      executionKind: base.executionKind,
      role: base.role,
    }),
  };

  if (overrides.system_prompt) out.systemPrompt = row.systemPrompt;
  if (overrides.tools_json) out.tools = (row.toolsJson as string[]) ?? [];
  if (overrides.mcp_servers_json) out.mcpServers = (row.mcpServersJson as string[]) ?? [];
  if (overrides.skills_json) out.skills = (row.skillsJson as string[]) ?? [];
  if (overrides.subscriptions_json) {
    out.subscriptions = row.subscriptionsJson as RuntimeAgentDefinition["subscriptions"];
  }
  if (overrides.llm_provider) out.llmProvider = row.llmProvider;
  if (overrides.llm_config_json) {
    const llmConfig = parseLlmConfigJson(row.llmConfigJson);
    if (llmConfig) out.llmConfig = llmConfig;
    else delete out.llmConfig;
  }
  if (overrides.outputs_json) {
    const outputsRaw = row.outputsJson;
    const outputs = Array.isArray(outputsRaw)
      ? (outputsRaw.filter((x): x is AgentOutput => typeof x === "string") as AgentOutput[])
      : [];
    if (outputs.length > 0) out.outputs = outputs;
    else delete out.outputs;
  }
  if (overrides.max_iterations) out.maxIterations = row.maxIterations;
  if (overrides.sandbox_policy_id) out.sandboxPolicyId = row.sandboxPolicyId;
  if (overrides.enabled) out.enabled = Boolean(row.enabled);
  if (overrides.execution_kind) {
    out.executionKind = resolveExecutionKind({
      executionKind: row.executionKind,
      role: row.role,
    });
  }

  return out;
}

/**
 * Load agent definitions from workspace JSON (or seed fallback), then apply
 * only DB fields whose `user_overrides_json` sentinel is true.
 */
export async function resolveEffectiveAgentDefinitions(
  rootDir = process.cwd()
): Promise<RuntimeAgentDefinition[]> {
  const loaded = await loadWorkspaceRuntimeConfig(rootDir);
  const jsonDefs = loaded.config?.definitions ?? [];
  const baseDefs =
    jsonDefs.length > 0
      ? jsonDefs
      : SEED_AGENT_DEFINITIONS.map((d) => ({
          ...d,
          executionKind: resolveExecutionKind({
            executionKind: d.executionKind,
            role: d.role,
          }),
        }));

  const db = await getDb();
  const rows = await db.select().from(agentDefinition);
  const byId = new Map(rows.map((r) => [r.id, r]));

  return baseDefs
    .map((base) => applyDbOverrides(base, byId.get(base.id)))
    .filter((d) => d.enabled);
}
