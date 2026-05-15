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
import { SEED_AGENT_DEFINITIONS } from "./seed-agent-definitions-data";
import { seedBrokerMcpServer } from "./seed-broker-mcp";
import {
  defaultQuantMcpServers,
  mergeMcpServers,
  seedRecommendedMcpServers,
} from "./seed-recommended-mcp-servers";

export { SEED_AGENT_DEFINITIONS };

/** 内置分析师编组 ID（与成员 definition id 一并由 seed 维护） */
export const DEFAULT_ANALYST_AGENT_GROUP_ID = "grp-default-analyst-team";

/** 挂载推荐数学/金融 MCP 的角色 */
const QUANT_MCP_ROLES = new Set([
  "orchestrator",
  "market_data",
  "research",
  "backtest",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "risk",
  "risk_manager",
]);

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

  const quantMcps = defaultQuantMcpServers();

  for (const def of SEED_AGENT_DEFINITIONS) {
    const mcpServers = QUANT_MCP_ROLES.has(def.role)
      ? mergeMcpServers(def.mcpServers, quantMcps)
      : def.mcpServers;
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
        skillsJson: def.skills,
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
          skillsJson: def.skills,
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
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agentProfile.id, profRows[0].id));
    } else {
      await db.insert(agentProfile).values({
        id: randomUUID(),
        definitionId: def.id,
        displayName: def.name,
        soulFileRef: "",
        description: "",
        tagsJson: [],
        enabled: true,
        configRootUri: "",
        memoryNamespace: "",
        promptMode: "db_primary",
        configContentHash: "",
        configSyncedAt: "",
      });
    }
  }

  console.log(`[Seed] Upserted ${SEED_AGENT_DEFINITIONS.length} agent definitions.`);
  const removedDupes = await cleanupRedundantAgentDefinitions(db);
  if (removedDupes > 0) {
    console.log(`[Seed] Removed ${removedDupes} redundant custom agent definition(s).`);
  }
  await seedRecommendedMcpServers();
  await seedBrokerMcpServer();
  await ensureDefaultAnalystAgentGroup();
}

/**
 * 保证存在「默认研究团队」编组，便于前端下拉选用；成员与内置 definition id 对齐（含 orchestrator）。
 */
export async function ensureDefaultAnalystAgentGroup(): Promise<void> {
  const db = await getDb();
  const memberDefs = [
    "def-orchestrator",
    "def-analyst-fundamental",
    "def-analyst-technical",
    "def-analyst-sentiment",
    "def-analyst-macro",
    "def-research",
    "def-backtest",
    "def-risk",
    "def-risk-manager",
  ] as const;

  const memberRoles = [
    "orchestrator",
    "analyst_fundamental",
    "analyst_technical",
    "analyst_sentiment",
    "analyst_macro",
    "research",
    "backtest",
    "risk",
    "risk_manager",
  ];

  // 默认拓扑：orchestrator 作为主导节点，向专家发布任务，并接收回报/裁判。
  // 仅用于“展示与计划拓扑”；研究团队并行槽位执行仍由 analyst_* 等槽位主导。
  const defaultNodePositions = (() => {
    const cx = 420;
    const cy = 240;
    const rx = 200;
    const ry = 160;
    const others = memberRoles.filter((r) => r !== "orchestrator");
    const out: Record<string, { x: number; y: number }> = {
      orchestrator: { x: cx, y: 80 },
    };
    const n = Math.max(others.length, 1);
    for (let i = 0; i < others.length; i++) {
      const role = others[i];
      if (!role) continue;
      const ang = (2 * Math.PI * i) / n - Math.PI / 2;
      out[role] = { x: cx + Math.cos(ang) * rx, y: cy + Math.sin(ang) * ry };
    }
    return out;
  })();

  const defaultRelationsJson = (() => {
    const others = memberRoles.filter((r) => r !== "orchestrator");
    const edges: Array<{ from: string; to: string; edgeKind: "unicast" }> = [];
    for (const to of others) edges.push({ from: "orchestrator", to, edgeKind: "unicast" });
    for (const from of others) edges.push({ from, to: "orchestrator", edgeKind: "unicast" });
    return [{ type: "topology_canvas", nodePositions: defaultNodePositions }, ...edges];
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
      return !JSON.stringify(currentRelationsJson).includes("orchestrator");
    } catch {
      return true;
    }
  })();

  await db
    .insert(agentGroup)
    .values({
      id: DEFAULT_ANALYST_AGENT_GROUP_ID,
      workspaceId: null,
      name: "默认研究团队（分析师 + 策略/回测/风控）",
      description:
        "启动时自动维护：含 orchestrator（拓扑/编排节点）；四名 analyst_* 参与 MSA；research / backtest / risk / risk_manager 产出辅助章节。可在「配置中心 → Agent」调整。",
      relationsJson: defaultRelationsJson,
    })
    .onConflictDoUpdate({
      target: agentGroup.id,
      set: {
        name: "默认研究团队（分析师 + 策略/回测/风控）",
        description:
          "启动时自动维护：含 orchestrator（拓扑/编排节点）；四名 analyst_* 参与 MSA；research / backtest / risk / risk_manager 产出辅助章节。可在「配置中心 → Agent」调整。",
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

if (import.meta.main) {
  void seedAgentDefinitions().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
