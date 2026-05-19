import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import {
  agentDefinition,
  agentGroup,
  agentGroupMember,
  agentProfile,
  llmProviderConfig,
  sandboxPolicy,
} from "../db/sqlite/schema";
import { cleanupRedundantAgentDefinitions } from "./agent/delete-agent-definition";
import { purgeRetiredBuiltinDefinitions } from "./agent/purge-retired-builtin-definitions";
import {
  getDataDir,
  syncWorkspacePromptFromCanonical,
} from "./agent/agent-pack-service";
import { DEFAULT_ORCHESTRATION_GROUP } from "./seed-agent-catalog";
import {
  SEED_AGENT_DEFINITIONS,
} from "./seed-agent-definitions-data";
import { syncOrchestratorTopologyToolsForGroup } from "./orchestration/sync-orchestrator-topology-tools";
import { isFsiActive } from "./fsi/fsi-config";
import { mergeFsiSkillsForRole } from "./fsi/fsi-prompt-enricher";
import { runFsiSeedIntegration, seedFsiSandboxPresets } from "./fsi/seed-fsi-integration";
import { shouldApplyFsiAgentMappings } from "./fsi/fsi-config";
import { seedBrokerMcpServer } from "./seed-broker-mcp";
import { seedRecommendedMcpServers } from "./seed-recommended-mcp-servers";

export { SEED_AGENT_DEFINITIONS };

/** 内置编排团队编组 ID */
export const DEFAULT_ANALYST_AGENT_GROUP_ID = DEFAULT_ORCHESTRATION_GROUP.id;

const DEFAULT_SANDBOX_POLICY = {
  id: "default-policy",
  name: "default-policy",
  description: "Default runtime policy for bootstrap phase.",
  allowedToolsJson: [],
  allowedMcpServersJson: [],
  allowedConnectorsJson: [],
  allowedHostsJson: [],
  allowedFsPathsJson: [],
  canWriteMemory: true,
  canReadLiveMarket: false,
  canSubmitOrder: false,
  maxToolCallMs: 30_000,
  maxIterationsPerRun: 20,
  maxOutputTokens: 4096,
  isolationLevel: "none" as const,
};

const DEFAULT_LLM_PROVIDER = {
  id: "llm-openai-gpt-4o",
  providerId: "openai:gpt-4o",
  providerType: "openai" as const,
  baseUrl: null,
  modelName: "gpt-4o",
  apiKeyRef: null,
  contextWindow: 128_000,
  supportsFunctionCalling: true,
  enabled: true,
};

export async function seedAgentDefinitions(): Promise<void> {
  const db = await getDb();

  await db
    .insert(sandboxPolicy)
    .values(DEFAULT_SANDBOX_POLICY)
    .onConflictDoUpdate({
      target: sandboxPolicy.id,
      set: {
        ...DEFAULT_SANDBOX_POLICY,
        updatedAt: new Date().toISOString(),
      },
    });

  await db.insert(llmProviderConfig).values(DEFAULT_LLM_PROVIDER).onConflictDoUpdate({
    target: llmProviderConfig.id,
    set: DEFAULT_LLM_PROVIDER,
  });

  await seedFsiSandboxPresets();

  for (const def of SEED_AGENT_DEFINITIONS) {
    const mcpServers = def.mcpServers;
    const skillsJson =
      isFsiActive() && shouldApplyFsiAgentMappings()
        ? await mergeFsiSkillsForRole(def.role, def.skills)
        : def.skills;
    await db
      .insert(agentDefinition)
      .values({
        id: def.id,
        role: def.role,
        name: def.name,
        version: def.version,
        systemPrompt: def.systemPrompt,
        toolsJson: def.tools,
        mcpServersJson: mcpServers,
        skillsJson,
        subscriptionsJson: def.subscriptions,
        llmProvider: def.llmProvider,
        maxIterations: def.maxIterations,
        sandboxPolicyId: def.sandboxPolicyId,
        enabled: def.enabled,
      })
      .onConflictDoUpdate({
        target: agentDefinition.id,
        set: {
          role: def.role,
          name: def.name,
          version: def.version,
          systemPrompt: def.systemPrompt,
          toolsJson: def.tools,
          mcpServersJson: mcpServers,
          skillsJson,
          subscriptionsJson: def.subscriptions,
          llmProvider: def.llmProvider,
          maxIterations: def.maxIterations,
          sandboxPolicyId: def.sandboxPolicyId,
          enabled: def.enabled,
          updatedAt: new Date().toISOString(),
        },
      });
    const profRows = await db
      .select()
      .from(agentProfile)
      .where(eq(agentProfile.definitionId, def.id))
      .limit(1);
    if (profRows[0]) {
      await db
        .update(agentProfile)
        .set({
          displayName: def.name,
          promptMode: "db_primary",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agentProfile.id, profRows[0].id));
    } else {
      await db.insert(agentProfile).values({
        id: randomUUID(),
        definitionId: def.id,
        displayName: def.name,
        soulFileRef: "",
        description: `QUBIT 内置 ${def.role} Agent`,
        tagsJson: ["builtin", def.role],
        enabled: true,
        configRootUri: "",
        memoryNamespace: "",
        promptMode: "db_primary",
        configContentHash: "",
        configSyncedAt: "",
      });
    }

    const profAfter = await db
      .select({ configRootUri: agentProfile.configRootUri })
      .from(agentProfile)
      .where(eq(agentProfile.definitionId, def.id))
      .limit(1);
    await syncWorkspacePromptFromCanonical({
      dataDir: getDataDir(),
      definitionId: def.id,
      systemPrompt: def.systemPrompt,
      configRootUri: profAfter[0]?.configRootUri ?? "",
    });
  }

  console.log(`[Seed] Upserted ${SEED_AGENT_DEFINITIONS.length} agent definitions.`);
  const removedDupes = await cleanupRedundantAgentDefinitions(db);
  if (removedDupes > 0) {
    console.log(`[Seed] Removed ${removedDupes} redundant custom agent definition(s).`);
  }
  await seedRecommendedMcpServers();
  await seedBrokerMcpServer();
  await runFsiSeedIntegration(SEED_AGENT_DEFINITIONS);
  const purged = await purgeRetiredBuiltinDefinitions(db);
  if (purged > 0) {
    console.log(`[Seed] Purged ${purged} retired built-in agent definition(s).`);
  }
  await ensureDefaultAnalystAgentGroup();
  await syncOrchestratorTopologyToolsForGroup(DEFAULT_ANALYST_AGENT_GROUP_ID);
}

/**
 * 保证存在「默认研究团队」编组，便于前端下拉选用；成员与内置 definition id 对齐（含 orchestrator）。
 */
export async function ensureDefaultAnalystAgentGroup(): Promise<void> {
  const db = await getDb();
  const memberDefs = [...DEFAULT_ORCHESTRATION_GROUP.memberDefinitionIds];
  const memberRoles = [...DEFAULT_ORCHESTRATION_GROUP.memberRoles];

  const defaultNodePositions: Record<string, { x: number; y: number }> = {
    orchestrator: { x: 420, y: 60 },
    market_data: { x: 180, y: 160 },
    news_event: { x: 660, y: 160 },
    analyst_fundamental: { x: 120, y: 280 },
    analyst_technical: { x: 280, y: 320 },
    analyst_sentiment: { x: 560, y: 320 },
    analyst_macro: { x: 720, y: 280 },
    research: { x: 240, y: 400 },
    backtest: { x: 400, y: 400 },
    risk: { x: 600, y: 400 },
  };

  const defaultRelationsJson = (() => {
    const others = memberRoles.filter((r) => r !== "orchestrator");
    const edges: Array<{ from: string; to: string; edgeKind: "unicast" }> = [];
    for (const to of others) edges.push({ from: "orchestrator", to, edgeKind: "unicast" });
    for (const from of others) edges.push({ from, to: "orchestrator", edgeKind: "unicast" });
    const pipeline = {
      type: "orchestration_pipeline",
      phases: [
        { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
        { id: "data", label: "数据层", roles: ["market_data", "news_event"] },
        { id: "msa", label: "四维分析", roles: ["analyst_fundamental", "analyst_technical", "analyst_sentiment", "analyst_macro"] },
        { id: "deepen", label: "策略深化", roles: ["research", "backtest"] },
        { id: "risk", label: "风控闸门", roles: ["risk"] },
      ],
    };
    return [
      { type: "topology_canvas", nodePositions: defaultNodePositions },
      pipeline,
      ...edges,
    ];
  })();

  const existing = await db
    .select({ relationsJson: agentGroup.relationsJson })
    .from(agentGroup)
    .where(eq(agentGroup.id, DEFAULT_ANALYST_AGENT_GROUP_ID))
    .limit(1);

  const currentRelationsJson = existing[0]?.relationsJson;
  const shouldInjectDefaultTopo = (() => {
    if (!currentRelationsJson) return true;
    if (Array.isArray(currentRelationsJson)) return currentRelationsJson.length === 0;
    try {
      const s = JSON.stringify(currentRelationsJson);
      if (!s.includes("orchestrator")) return true;
      if (s.includes("risk_manager")) return true;
      if (memberRoles.some((r) => !s.includes(`"${r}"`))) return true;
    } catch {
      return true;
    }
    return false;
  })();

  await db
    .insert(agentGroup)
    .values({
      id: DEFAULT_ANALYST_AGENT_GROUP_ID,
      workspaceId: null,
      name: DEFAULT_ORCHESTRATION_GROUP.name,
      description: DEFAULT_ORCHESTRATION_GROUP.description,
      relationsJson: defaultRelationsJson,
    })
    .onConflictDoUpdate({
      target: agentGroup.id,
      set: {
        name: DEFAULT_ORCHESTRATION_GROUP.name,
        description: DEFAULT_ORCHESTRATION_GROUP.description,
        updatedAt: new Date().toISOString(),
        ...(shouldInjectDefaultTopo ? { relationsJson: defaultRelationsJson } : {}),
      },
    });

  await db
    .delete(agentGroupMember)
    .where(eq(agentGroupMember.groupId, DEFAULT_ANALYST_AGENT_GROUP_ID));
  let sortOrder = 0;
  for (const definitionId of memberDefs) {
    await db.insert(agentGroupMember).values({
      id: randomUUID(),
      groupId: DEFAULT_ANALYST_AGENT_GROUP_ID,
      definitionId,
      sortOrder: sortOrder++,
    });
  }
  console.log(
    `[Seed] Default research team agent group ${DEFAULT_ANALYST_AGENT_GROUP_ID} refreshed (${memberDefs.length} members).`
  );
}

export { syncOrchestratorTopologyToolsForGroup };

if (import.meta.main) {
  void seedAgentDefinitions().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
