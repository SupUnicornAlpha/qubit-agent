import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, sandboxPolicy } from "../../db/sqlite/schema";
import type { RuntimeAgentDefinition } from "../types";
import {
  parseUserOverrides,
  type UserBindableField,
} from "../agent/agent-binding-service";
import type { WorkspaceSandboxPolicy } from "./workspace-config";

export async function syncWorkspaceConfigToDb(input: {
  definitions: RuntimeAgentDefinition[];
  policies: WorkspaceSandboxPolicy[];
}): Promise<void> {
  const db = await getDb();
  for (const policy of input.policies) {
    await db
      .insert(sandboxPolicy)
      .values({
        id: policy.id,
        name: policy.name,
        description: policy.description,
        allowedToolsJson: policy.allowedTools,
        allowedMcpServersJson: policy.allowedMcpServers,
        allowedConnectorsJson: policy.allowedConnectors,
        allowedHostsJson: policy.allowedHosts,
        allowedFsPathsJson: policy.allowedFsPaths,
        canWriteMemory: policy.canWriteMemory,
        canReadLiveMarket: policy.canReadLiveMarket,
        canSubmitOrder: policy.canSubmitOrder,
        maxToolCallMs: policy.maxToolCallMs,
        maxIterationsPerRun: policy.maxIterationsPerRun,
        maxOutputTokens: policy.maxOutputTokens,
        isolationLevel: policy.isolationLevel,
      })
      .onConflictDoUpdate({
        target: sandboxPolicy.id,
        set: {
          name: policy.name,
          description: policy.description,
          allowedToolsJson: policy.allowedTools,
          allowedMcpServersJson: policy.allowedMcpServers,
          allowedConnectorsJson: policy.allowedConnectors,
          allowedHostsJson: policy.allowedHosts,
          allowedFsPathsJson: policy.allowedFsPaths,
          canWriteMemory: policy.canWriteMemory,
          canReadLiveMarket: policy.canReadLiveMarket,
          canSubmitOrder: policy.canSubmitOrder,
          maxToolCallMs: policy.maxToolCallMs,
          maxIterationsPerRun: policy.maxIterationsPerRun,
          maxOutputTokens: policy.maxOutputTokens,
          isolationLevel: policy.isolationLevel,
          updatedAt: new Date().toISOString(),
        },
      });
  }

  /**
   * F-P0-06 fix: per-field user-override sentinel (migration 0074)。
   *
   * 之前这条 sync 是「.qubit/agents.json → DB UPSERT 全字段」，runtime 启动 / file
   * watcher 触发后会把 user 直连改的 mcp_servers_json / tools_json 抹回文件里的值
   * （文件本身是 SEED_AGENT_DEFINITIONS 生成的）。现在改为先读 DB 现存 row 的
   * user_overrides_json，对 sentinel=true 的字段跳过 `set:`。等价于「文件 → DB
   * 只补 user 没显式声明的字段」。
   */
  for (const def of input.definitions) {
    const existing = await db
      .select({
        id: agentDefinition.id,
        userOverridesJson: agentDefinition.userOverridesJson,
      })
      .from(agentDefinition)
      .where(eq(agentDefinition.id, def.id))
      .limit(1);
    const overrides = parseUserOverrides(existing[0]?.userOverridesJson);
    const preserveField = (col: UserBindableField): boolean => overrides[col] === true;

    const baseValues = {
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
      llmConfigJson: def.llmConfig ?? {},
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
      if (preserveField(col)) return;
      updateSet[key] = value;
    };
    maybeAdd("system_prompt", "systemPrompt", def.systemPrompt);
    maybeAdd("tools_json", "toolsJson", def.tools);
    maybeAdd("mcp_servers_json", "mcpServersJson", def.mcpServers);
    maybeAdd("skills_json", "skillsJson", def.skills);
    maybeAdd("subscriptions_json", "subscriptionsJson", def.subscriptions);
    maybeAdd("llm_provider", "llmProvider", def.llmProvider);
    maybeAdd("llm_config_json", "llmConfigJson", def.llmConfig ?? {});
    maybeAdd("max_iterations", "maxIterations", def.maxIterations);
    maybeAdd("sandbox_policy_id", "sandboxPolicyId", def.sandboxPolicyId);
    maybeAdd("enabled", "enabled", def.enabled);

    await db
      .insert(agentDefinition)
      .values(baseValues)
      .onConflictDoUpdate({ target: agentDefinition.id, set: updateSet });
  }
}

