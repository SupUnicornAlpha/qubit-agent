import { getDb } from "../../db/sqlite/client";
import { agentDefinition, sandboxPolicy } from "../../db/sqlite/schema";
import type { RuntimeAgentDefinition } from "../types";
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

  for (const def of input.definitions) {
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
}

