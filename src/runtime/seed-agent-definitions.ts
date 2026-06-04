import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { count, eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import {
  agentDefinition,
  agentDefinitionRelease,
  agentGroup,
  agentGroupMember,
  agentProfile,
  llmProviderConfig,
  sandboxPolicy,
} from "../db/sqlite/schema";
import type { AgentRole } from "../types/entities";
import { getDataDir, syncWorkspacePromptFromCanonical } from "./agent/agent-pack-service";
import { cleanupRedundantAgentDefinitions } from "./agent/delete-agent-definition";
import { purgeRetiredBuiltinDefinitions } from "./agent/purge-retired-builtin-definitions";
import { isFsiActive, shouldApplyFsiAgentMappings } from "./fsi/fsi-config";
import { mergeFsiSkillsForRole } from "./fsi/fsi-prompt-enricher";
import { runFsiSeedIntegration, seedFsiSandboxPresets } from "./fsi/seed-fsi-integration";
import { syncOrchestratorTopologyToolsForGroup } from "./orchestration/sync-orchestrator-topology-tools";
import {
  parseUserOverrides,
  type UserBindableField,
} from "./agent/agent-binding-service";
import {
  BUILTIN_AGENT_GROUPS,
  type BuiltinAgentGroupSpec,
  DEFAULT_ORCHESTRATION_GROUP,
  FULL_ANALYST_GROUP,
  STRATEGY_PIPELINE_GROUP,
} from "./seed-agent-catalog";
import { SEED_AGENT_DEFINITIONS } from "./seed-agent-definitions-data";
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

const LLM_PROVIDER_SEED_MARKER = "llm-provider-seed.json";

export type SeedOptions = {
  /**
   * 是否强制覆盖：
   * - `false`（默认，正常启动）：对用户已经"发布过"的 builtin Agent / 已经增删过成员的 builtin 编组，
   *   跳过覆盖，保留用户改动；
   * - `true`（手动 Reload 按钮）：忽略用户改动，把所有内置 Agent / 编组重置回 SEED。
   */
  force?: boolean;
};

export type SeedReport = {
  definitions: { total: number; reset: number; preserved: number };
  groups: { total: number; reset: number; preserved: number };
  force: boolean;
};

/**
 * 判断某个内置 Agent 是否被用户"发布过"：
 * 只要 `agent_definition_release` 表里存在该 definitionId 的至少一条 release，
 * 就视为用户改动过，不应被启动期 seed 覆盖。
 * 草稿（draft）阶段不算"已改"，仍然跟随 SEED。
 */
async function hasUserPublishedRelease(
  db: Awaited<ReturnType<typeof getDb>>,
  definitionId: string
): Promise<boolean> {
  const rows = await db
    .select({ c: count() })
    .from(agentDefinitionRelease)
    .where(eq(agentDefinitionRelease.definitionId, definitionId));
  return (rows[0]?.c ?? 0) > 0;
}

async function hasSeededDefaultLlmProvider(): Promise<boolean> {
  try {
    const raw = await readFile(join(getDataDir(), "config", LLM_PROVIDER_SEED_MARKER), "utf8");
    const parsed = JSON.parse(raw) as { defaultProviderSeeded?: boolean };
    return parsed.defaultProviderSeeded === true;
  } catch {
    return false;
  }
}

async function markDefaultLlmProviderSeeded(): Promise<void> {
  const dir = join(getDataDir(), "config");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, LLM_PROVIDER_SEED_MARKER),
    JSON.stringify({ defaultProviderSeeded: true, updatedAt: new Date().toISOString() }, null, 2)
  );
}

async function seedDefaultLlmProviderOnce(db: Awaited<ReturnType<typeof getDb>>): Promise<void> {
  if (await hasSeededDefaultLlmProvider()) return;

  const existingRows = await db.select({ c: count() }).from(llmProviderConfig);
  const existingCount = existingRows[0]?.c ?? 0;

  if (existingCount === 0) {
    await db.insert(llmProviderConfig).values(DEFAULT_LLM_PROVIDER);
  }

  await markDefaultLlmProviderSeeded();
}

export async function seedAgentDefinitions(options: SeedOptions = {}): Promise<SeedReport> {
  const force = options.force === true;
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

  await seedDefaultLlmProviderOnce(db);

  await seedFsiSandboxPresets();

  let resetCount = 0;
  let preservedCount = 0;
  let perFieldPreservedCount = 0;

  for (const def of SEED_AGENT_DEFINITIONS) {
    const existing = await db
      .select({
        id: agentDefinition.id,
        userOverridesJson: agentDefinition.userOverridesJson,
      })
      .from(agentDefinition)
      .where(eq(agentDefinition.id, def.id))
      .limit(1);
    const isExisting = existing.length > 0;
    const userOwned = isExisting && !force && (await hasUserPublishedRelease(db, def.id));

    if (userOwned) {
      preservedCount += 1;
      continue;
    }

    /**
     * F-P0-06 fix: per-field user-override sentinel (migration 0074).
     *
     * 即使 def 整体没走 release 流程，用户也可能通过 setAgentDefinitionBindings()
     * 或直连 SQL 标记某些字段为 user-owned。这里读出 sentinel map，构造 UPSERT
     * 时用 `pick()` 过滤掉这些字段，让它们维持 DB 现值不被 seed 抹回。
     *
     * `force=true`（builtin/reload）时跳过过滤 → 等价 factory reset。
     */
    const overrides = force ? {} : parseUserOverrides(existing[0]?.userOverridesJson);
    const preserveField = (col: UserBindableField): boolean => overrides[col] === true;
    let perFieldHit = false;

    const mcpServers = def.mcpServers;
    const skillsJson =
      isFsiActive() && shouldApplyFsiAgentMappings()
        ? await mergeFsiSkillsForRole(def.role, def.skills)
        : def.skills;
    const outputsJson = def.outputs ?? [];

    const baseValues = {
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
      llmConfigJson: def.llmConfig ?? {},
      outputsJson,
      maxIterations: def.maxIterations,
      sandboxPolicyId: def.sandboxPolicyId,
      enabled: def.enabled,
    } as const;

    const updateSet: Record<string, unknown> = {
      role: def.role,
      name: def.name,
      version: def.version,
      updatedAt: new Date().toISOString(),
    };
    const maybeAdd = (col: UserBindableField, key: string, value: unknown): void => {
      if (preserveField(col)) {
        perFieldHit = true;
        return;
      }
      updateSet[key] = value;
    };
    maybeAdd("system_prompt", "systemPrompt", def.systemPrompt);
    maybeAdd("tools_json", "toolsJson", def.tools);
    maybeAdd("mcp_servers_json", "mcpServersJson", mcpServers);
    maybeAdd("skills_json", "skillsJson", skillsJson);
    maybeAdd("subscriptions_json", "subscriptionsJson", def.subscriptions);
    maybeAdd("llm_provider", "llmProvider", def.llmProvider);
    maybeAdd("llm_config_json", "llmConfigJson", def.llmConfig ?? {});
    maybeAdd("outputs_json", "outputsJson", outputsJson);
    maybeAdd("max_iterations", "maxIterations", def.maxIterations);
    maybeAdd("sandbox_policy_id", "sandboxPolicyId", def.sandboxPolicyId);
    maybeAdd("enabled", "enabled", def.enabled);

    await db
      .insert(agentDefinition)
      .values(baseValues)
      .onConflictDoUpdate({ target: agentDefinition.id, set: updateSet });
    resetCount += 1;
    if (perFieldHit) perFieldPreservedCount += 1;

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

  const total = SEED_AGENT_DEFINITIONS.length;
  const perFieldNote =
    perFieldPreservedCount > 0
      ? `, perFieldPreserved=${perFieldPreservedCount} (user_overrides_json)`
      : "";
  if (preservedCount > 0) {
    console.log(
      `[Seed] Agent definitions: reset=${resetCount}, preserved=${preservedCount} (user-published)${perFieldNote}, total=${total}${force ? " [force]" : ""}.`
    );
  } else {
    console.log(
      `[Seed] Upserted ${resetCount}/${total} agent definitions${perFieldNote}${force ? " [force]" : ""}.`
    );
  }

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
  const groupReport = await ensureBuiltinAgentGroups({ force });
  await syncOrchestratorTopologyToolsForGroup(DEFAULT_ANALYST_AGENT_GROUP_ID);

  return {
    definitions: { total, reset: resetCount, preserved: preservedCount },
    groups: groupReport,
    force,
  };
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
    /** P2-F: risk_manager → risk（与 def-risk 对齐） */
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      research: { x: 280, y: 240 },
      risk: { x: 560, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "draft", label: "规则草拟", roles: ["research"] },
      { id: "review", label: "风控复核", roles: ["risk"] },
    ],
    auxChain: ["research", "risk"],
  },
  "grp-stock-screening": {
    /** P2-F: stock_screener → research（M9.P5 选股职能并入 research） */
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      research: { x: 420, y: 220 },
      analyst_fundamental: { x: 240, y: 360 },
      analyst_sentiment: { x: 600, y: 360 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "screen", label: "因子+规则过滤", roles: ["research"] },
      { id: "deepen", label: "候选股复核", roles: ["analyst_fundamental", "analyst_sentiment"] },
    ],
    auxChain: ["research", "analyst_fundamental", "analyst_sentiment"],
  },
  "grp-risk-review": {
    /** P2-F: risk_manager + audit → risk + research（audit 已退役并入 monitor） */
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      risk: { x: 280, y: 240 },
      research: { x: 560, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "review", label: "限额/策略审查", roles: ["risk"] },
      { id: "audit", label: "策略历史与建议", roles: ["research"] },
    ],
    auxChain: ["risk", "research"],
  },
  "grp-portfolio-management": {
    /** P2-F: portfolio_manager + risk_manager → research + risk + backtest */
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      research: { x: 180, y: 240 },
      risk: { x: 420, y: 300 },
      backtest: { x: 660, y: 240 },
    },
    phases: [
      { id: "clarify", label: "澄清目标", roles: ["orchestrator"] },
      { id: "allocate", label: "权重分配", roles: ["research"] },
      { id: "validate", label: "风控核验", roles: ["risk"] },
      { id: "report", label: "暴露报告 + 回测验证", roles: ["backtest"] },
    ],
    auxChain: ["research", "risk", "backtest"],
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
    /**
     * P2-F: execution_trader + risk_manager → risk only。
     * def-execution-trader 已退役，当前实盘路径走的是 risk 签核 + monitor 兜底。
     * 如未来重建执行 agent，请新建 def 并更新此 layout。
     */
    nodePositions: {
      orchestrator: { x: 420, y: 60 },
      risk: { x: 420, y: 240 },
    },
    phases: [
      { id: "clarify", label: "确认信号", roles: ["orchestrator"] },
      { id: "guard", label: "风控签核 + 实盘闸门", roles: ["risk"] },
    ],
    auxChain: ["risk"],
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

async function memberSetMatchesSeed(
  db: Awaited<ReturnType<typeof getDb>>,
  groupId: string,
  expectedMemberDefs: readonly string[]
): Promise<boolean> {
  const rows = await db
    .select({ definitionId: agentGroupMember.definitionId })
    .from(agentGroupMember)
    .where(eq(agentGroupMember.groupId, groupId));
  if (rows.length !== expectedMemberDefs.length) return false;
  const actual = new Set(rows.map((r) => r.definitionId));
  for (const id of expectedMemberDefs) {
    if (!actual.has(id)) return false;
  }
  return true;
}

async function upsertBuiltinAgentGroup(
  db: Awaited<ReturnType<typeof getDb>>,
  spec: BuiltinAgentGroupSpec,
  options: { force: boolean }
): Promise<"reset" | "preserved" | "created"> {
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
  const isExisting = existing.length > 0;

  if (isExisting && !options.force) {
    const memberMatches = await memberSetMatchesSeed(db, spec.id, memberDefs);
    if (!memberMatches) {
      return "preserved";
    }
  }

  const shouldInjectTopo = relationsNeedsRefresh(existing[0]?.relationsJson, memberRoles);

  await db
    .insert(agentGroup)
    .values({
      id: spec.id,
      workspaceId: null,
      name: spec.name,
      description: spec.description,
      relationsJson,
      pipelineKind: spec.pipelineKind,
    })
    .onConflictDoUpdate({
      target: agentGroup.id,
      set: {
        name: spec.name,
        description: spec.description,
        pipelineKind: spec.pipelineKind,
        updatedAt: new Date().toISOString(),
        ...(shouldInjectTopo || options.force ? { relationsJson } : {}),
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
  return isExisting ? "reset" : "created";
}

/**
 * 保证存在内置研究团队编组，便于前端成员目录选用。
 * - 默认（`force=false`）：用户改过成员集合的编组会被原样保留；
 * - 手动 Reload（`force=true`）：忽略用户改动全量重置。
 */
export async function ensureBuiltinAgentGroups(
  options: SeedOptions = {}
): Promise<{ total: number; reset: number; preserved: number }> {
  const force = options.force === true;
  const db = await getDb();
  let reset = 0;
  let preserved = 0;
  for (const spec of BUILTIN_AGENT_GROUPS) {
    const outcome = await upsertBuiltinAgentGroup(db, spec, { force });
    if (outcome === "preserved") {
      preserved += 1;
    } else {
      reset += 1;
    }
  }
  const total = BUILTIN_AGENT_GROUPS.length;
  if (preserved > 0) {
    console.log(
      `[Seed] Builtin agent groups: reset=${reset}, preserved=${preserved} (user-modified members), total=${total}${force ? " [force]" : ""}.`
    );
  } else {
    console.log(`[Seed] Builtin agent groups refreshed: ${reset}/${total}${force ? " [force]" : ""}.`);
  }
  return { total, reset, preserved };
}

export { syncOrchestratorTopologyToolsForGroup };

if (import.meta.main) {
  void seedAgentDefinitions().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
