import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import {
  agentDefinition,
  agentGroup,
  agentGroupMember,
  llmProviderConfig,
  sandboxPolicy,
} from "../db/sqlite/schema";
import { SEED_AGENT_DEFINITIONS } from "./seed-agent-definitions-data";

export { SEED_AGENT_DEFINITIONS };

/** 内置分析师编组 ID（与成员 definition id 一并由 seed 维护） */
export const DEFAULT_ANALYST_AGENT_GROUP_ID = "grp-default-analyst-team";

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

  for (const def of SEED_AGENT_DEFINITIONS) {
    await db
      .insert(agentDefinition)
      .values({
        id: def.id,
        role: def.role,
        name: def.name,
        version: def.version,
        systemPrompt: def.systemPrompt,
        toolsJson: def.tools,
        mcpServersJson: def.mcpServers,
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
          mcpServersJson: def.mcpServers,
          skillsJson: def.skills,
          subscriptionsJson: def.subscriptions,
          llmProvider: def.llmProvider,
          maxIterations: def.maxIterations,
          sandboxPolicyId: def.sandboxPolicyId,
          enabled: def.enabled,
          updatedAt: new Date().toISOString(),
        },
      });
  }

  console.log(`[Seed] Upserted ${SEED_AGENT_DEFINITIONS.length} agent definitions.`);
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

  await db
    .insert(agentGroup)
    .values({
      id: DEFAULT_ANALYST_AGENT_GROUP_ID,
      workspaceId: null,
      name: "默认研究团队（分析师 + 策略/回测/风控）",
      description:
        "启动时自动维护：含 orchestrator（拓扑/编排节点）；四名 analyst_* 参与 MSA；research / backtest / risk / risk_manager 产出辅助章节。可在「配置中心 → Agent」调整。",
      relationsJson: [],
    })
    .onConflictDoUpdate({
      target: agentGroup.id,
      set: {
        name: "默认研究团队（分析师 + 策略/回测/风控）",
        description:
          "启动时自动维护：含 orchestrator（拓扑/编排节点）；四名 analyst_* 参与 MSA；research / backtest / risk / risk_manager 产出辅助章节。可在「配置中心 → Agent」调整。",
        updatedAt: new Date().toISOString(),
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
