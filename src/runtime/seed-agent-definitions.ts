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
import {
  BUILTIN_AGENT_GROUPS,
  DEFAULT_ORCHESTRATION_GROUP,
  FULL_ANALYST_GROUP,
  STRATEGY_PIPELINE_GROUP,
  type BuiltinAgentGroupSpec,
} from "./seed-agent-catalog";
import type { AgentRole } from "../types/entities";
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
export const FULL_ANALYST_AGENT_GROUP_ID = FULL_ANALYST_GROUP.id;
export const STRATEGY_PIPELINE_AGENT_GROUP_ID = STRATEGY_PIPELINE_GROUP.id;

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
  await ensureBuiltinAgentGroups();
  await syncOrchestratorTopologyToolsForGroup(DEFAULT_ANALYST_AGENT_GROUP_ID);
}

type GroupRelationsLayout = {
  nodePositions: Record<string, { x: number; y: number }>;
  phases: Array<{ id: string; label: string; roles: AgentRole[] }>;
  analystChain?: AgentRole[];
  auxChain?: AgentRole[];
};

function buildBuiltinGroupRelationsJson(
  memberRoles: readonly AgentRole[],
  layout: GroupRelationsLayout
): unknown[] {
  const others = memberRoles.filter((r) => r !== "orchestrator");
  const edges: Array<{ from: string; to: string; edgeKind: "unicast" }> = [];
  for (const to of others) edges.push({ from: "orchestrator", to, edgeKind: "unicast" });
  for (const from of others) edges.push({ from, to: "orchestrator", edgeKind: "unicast" });
  if (layout.analystChain) {
    for (let i = 1; i < layout.analystChain.length; i++) {
      edges.push({
        from: layout.analystChain[i - 1]!,
        to: layout.analystChain[i]!,
        edgeKind: "unicast",
      });
    }
  }
  if (layout.auxChain) {
    for (let i = 1; i < layout.auxChain.length; i++) {
      edges.push({
        from: layout.auxChain[i - 1]!,
        to: layout.auxChain[i]!,
        edgeKind: "unicast",
      });
    }
  }
  const pipeline = {
    type: "orchestration_pipeline",
    phases: layout.phases,
  };
  return [
    { type: "topology_canvas", nodePositions: layout.nodePositions },
    pipeline,
    ...edges,
  ];
}

function relationsNeedsRefresh(
  currentRelationsJson: unknown,
  memberRoles: readonly AgentRole[]
): boolean {
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
}

export const BUILTIN_GROUP_LAYOUTS: Record<string, GroupRelationsLayout> = {
  [DEFAULT_ORCHESTRATION_GROUP.id]: {
    nodePositions: {
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
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "data", label: "数据层", roles: ["market_data", "news_event"] },
      {
        id: "msa",
        label: "四维分析",
        roles: [
          "analyst_fundamental",
          "analyst_technical",
          "analyst_sentiment",
          "analyst_macro",
        ],
      },
      { id: "deepen", label: "策略深化", roles: ["research", "backtest"] },
      { id: "risk", label: "风控闸门", roles: ["risk"] },
    ],
    auxChain: ["research", "backtest", "risk"],
  },
  [FULL_ANALYST_GROUP.id]: {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      analyst_macro: { x: 120, y: 220 },
      analyst_fundamental: { x: 280, y: 260 },
      analyst_technical: { x: 440, y: 300 },
      analyst_sentiment: { x: 600, y: 260 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      {
        id: "msa",
        label: "四维分析",
        roles: [
          "analyst_macro",
          "analyst_fundamental",
          "analyst_technical",
          "analyst_sentiment",
        ],
      },
    ],
    analystChain: [
      "analyst_macro",
      "analyst_fundamental",
      "analyst_technical",
      "analyst_sentiment",
    ],
  },
  [STRATEGY_PIPELINE_GROUP.id]: {
    nodePositions: {
      orchestrator: { x: 420, y: 80 },
      research: { x: 240, y: 240 },
      backtest: { x: 420, y: 300 },
      risk: { x: 600, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "strategy", label: "策略撰写", roles: ["research"] },
      { id: "backtest", label: "回测验证", roles: ["backtest"] },
      { id: "risk", label: "风控复核", roles: ["risk"] },
    ],
    auxChain: ["research", "backtest", "risk"],
  },
  // ─── M1：研究场景化编组 layout（与 seed-agent-catalog.ts 中的 9 个 GROUP 一一对应） ───
  "grp-factor-research": {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      research: { x: 420, y: 220 },
      analyst_fundamental: { x: 240, y: 360 },
      analyst_technical: { x: 600, y: 360 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "generate", label: "候选因子生成", roles: ["research"] },
      { id: "evaluate", label: "因子评估", roles: ["analyst_fundamental", "analyst_technical"] },
    ],
    auxChain: ["research", "analyst_fundamental", "analyst_technical"],
  },
  "grp-rule-research": {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      research: { x: 280, y: 240 },
      risk_manager: { x: 560, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "draft", label: "规则草拟", roles: ["research"] },
      { id: "review", label: "风控复核", roles: ["risk_manager"] },
    ],
    auxChain: ["research", "risk_manager"],
  },
  "grp-stock-screening": {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      stock_screener: { x: 420, y: 220 },
      analyst_fundamental: { x: 240, y: 360 },
      analyst_sentiment: { x: 600, y: 360 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "screen", label: "因子+规则过滤", roles: ["stock_screener"] },
      { id: "deepen", label: "候选股复核", roles: ["analyst_fundamental", "analyst_sentiment"] },
    ],
    auxChain: ["stock_screener", "analyst_fundamental", "analyst_sentiment"],
  },
  "grp-risk-review": {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      risk_manager: { x: 280, y: 240 },
      audit: { x: 560, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "review", label: "限额/策略审查", roles: ["risk_manager"] },
      { id: "audit", label: "审计与建议", roles: ["audit"] },
    ],
    auxChain: ["risk_manager", "audit"],
  },
  "grp-portfolio-management": {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      portfolio_manager: { x: 180, y: 240 },
      risk_manager: { x: 420, y: 300 },
      research: { x: 660, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "allocate", label: "权重分配", roles: ["portfolio_manager"] },
      { id: "validate", label: "风控核验", roles: ["risk_manager"] },
      { id: "report", label: "暴露报告", roles: ["research"] },
    ],
    auxChain: ["portfolio_manager", "risk_manager", "research"],
  },
  "grp-discovery": {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      research: { x: 200, y: 240 },
      backtest: { x: 420, y: 240 },
      backtest_engineer: { x: 640, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "evolve", label: "候选演化", roles: ["research"] },
      { id: "select", label: "回测筛选", roles: ["backtest"] },
      { id: "validate", label: "Walk-Forward 验证", roles: ["backtest_engineer"] },
    ],
    auxChain: ["research", "backtest", "backtest_engineer"],
  },
  "grp-live-trading": {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      execution_trader: { x: 280, y: 240 },
      risk_manager: { x: 560, y: 240 },
    },
    phases: [
      { id: "clarify", label: "确认信号", roles: ["orchestrator"] },
      { id: "execute", label: "下单执行", roles: ["execution_trader"] },
      { id: "guard", label: "风控闸门", roles: ["risk_manager"] },
    ],
    auxChain: ["execution_trader", "risk_manager"],
  },
  "grp-postmortem": {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      research: { x: 280, y: 240 },
      analyst_macro: { x: 560, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "attribute", label: "归因分析", roles: ["research"] },
      { id: "macro", label: "宏观/行业归因", roles: ["analyst_macro"] },
    ],
    auxChain: ["research", "analyst_macro"],
  },
  "grp-news-event-radar": {
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      news_event: { x: 280, y: 240 },
      analyst_sentiment: { x: 560, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "scan", label: "事件扫描", roles: ["news_event"] },
      { id: "assess", label: "影响评估", roles: ["analyst_sentiment"] },
    ],
    auxChain: ["news_event", "analyst_sentiment"],
  },
};

async function upsertBuiltinAgentGroup(db: Awaited<ReturnType<typeof getDb>>, spec: BuiltinAgentGroupSpec): Promise<void> {
  const memberDefs = [...spec.memberDefinitionIds];
  const memberRoles = [...spec.memberRoles];
  const layout = BUILTIN_GROUP_LAYOUTS[spec.id];
  if (!layout) {
    throw new Error(`Missing builtin layout for agent group ${spec.id}`);
  }
  const relationsJson = buildBuiltinGroupRelationsJson(memberRoles, layout);

  const existing = await db
    .select({ relationsJson: agentGroup.relationsJson })
    .from(agentGroup)
    .where(eq(agentGroup.id, spec.id))
    .limit(1);

  const shouldInjectTopo = relationsNeedsRefresh(existing[0]?.relationsJson, memberRoles);

  await db
    .insert(agentGroup)
    .values({
      id: spec.id,
      workspaceId: null,
      name: spec.name,
      description: spec.description,
      relationsJson,
    })
    .onConflictDoUpdate({
      target: agentGroup.id,
      set: {
        name: spec.name,
        description: spec.description,
        updatedAt: new Date().toISOString(),
        ...(shouldInjectTopo ? { relationsJson } : {}),
      },
    });

  await db.delete(agentGroupMember).where(eq(agentGroupMember.groupId, spec.id));
  let sortOrder = 0;
  for (const definitionId of memberDefs) {
    await db.insert(agentGroupMember).values({
      id: randomUUID(),
      groupId: spec.id,
      definitionId,
      sortOrder: sortOrder++,
    });
  }
  console.log(`[Seed] Builtin agent group ${spec.id} refreshed (${memberDefs.length} members).`);
}

/** @deprecated 使用 ensureBuiltinAgentGroups */
export async function ensureDefaultAnalystAgentGroup(): Promise<void> {
  await ensureBuiltinAgentGroups();
}

/**
 * 保证存在内置研究团队编组，便于前端成员目录选用。
 */
export async function ensureBuiltinAgentGroups(): Promise<void> {
  const db = await getDb();
  for (const spec of BUILTIN_AGENT_GROUPS) {
    await upsertBuiltinAgentGroup(db, spec);
  }
}

export { syncOrchestratorTopologyToolsForGroup };

if (import.meta.main) {
  void seedAgentDefinitions().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
