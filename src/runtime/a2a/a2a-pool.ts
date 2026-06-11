import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  project,
  workflowRun,
  workspace,
} from "../../db/sqlite/schema";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";
import { AgentRuntime } from "../agent-runtime";
import {
  computeConfigHash,
  startWorkspaceConfigWatcher,
  syncWorkspaceConfigToDbFromFiles,
  type WorkspaceConfigWatcherHandle,
} from "../config/workspace-config-watcher";
import { getRoleHandler } from "../handlers/role-handlers";
import { parseLlmConfigJson } from "../llm/agent-llm-config";
import type { RuntimeAgentDefinition } from "../types";
import type { AgentRole } from "../../types/entities";
import {
  A2A_POOL_PROJECT_ID,
  A2A_POOL_WORKFLOW_ID,
} from "./constants";

const A2A_POOL_WORKSPACE_ID = "00000000-0000-4000-8000-a2a000000003";

type PoolEntry = {
  runtime: AgentRuntime;
  instanceId: string;
  role: AgentRole;
};

export class A2APool {
  private entries = new Map<AgentRole, PoolEntry>();
  private started = false;
  private configWatcher: WorkspaceConfigWatcherHandle | null = null;
  private reloading = false;

  async start(): Promise<void> {
    if (this.started) return;
    // 启动前先把 .qubit/*.json 配置 sync 进 DB（原 GraphRunner.syncFromWorkspaceConfig
    // 职责，现移到 workspace-config-watcher），再从 DB 加载 definitions。
    await syncWorkspaceConfigToDbFromFiles();
    await this.ensurePoolInfrastructure();
    const definitions = await this.loadDefinitions();

    for (const def of definitions) {
      if (!def.enabled) continue;
      const instanceId = await this.ensurePoolInstance(def);
      const runtime = new AgentRuntime(def, getRoleHandler(def.role), { instanceId });
      await runtime.start();
      this.entries.set(def.role, { runtime, instanceId, role: def.role });
    }

    this.started = true;
    this.startConfigWatcher();
    console.log(`[A2APool] started ${this.entries.size} role runtimes.`);
  }

  async stop(): Promise<void> {
    this.stopConfigWatcher();
    for (const entry of this.entries.values()) {
      await entry.runtime.stop();
    }
    this.entries.clear();
    this.started = false;
    console.log("[A2APool] stopped.");
  }

  /**
   * 配置热加载：重载 agent definitions 并优雅地换掉每个 role 的 AgentRuntime。
   *
   * 关键约束（不丢消息 / 不双订阅）：逐 role **先 stop 旧 runtime（解订阅）→ 再 start
   * 新 runtime（建新订阅）**。AgentRuntime.stop() 会同步执行 unsubscribeFns，
   * start() 才重新 `a2aRouter.on(...)`，所以同一 role 任意时刻最多一个活跃订阅，
   * 不会出现「旧+新」双份 handler 处理同一条消息。
   *
   * 没了的 role（新配置里 disabled / 删除）→ stop 后从 entries 移除。
   * 新增 role → 直接 start 并加入 entries。
   *
   * 失败 fail-soft：单个 role 重建出错只告警，保留其它 role；整体 sync 出错则保持原池。
   *
   * 返回 { before, after } 与原 GraphRunner.reload 形状一致，方便 routes 平滑替换。
   */
  async reload(): Promise<{ before: number; after: number }> {
    const before = this.entries.size;
    if (this.reloading) return { before, after: before };
    this.reloading = true;
    try {
      await syncWorkspaceConfigToDbFromFiles();
      await this.ensurePoolInfrastructure();
      const definitions = await this.loadDefinitions();
      const nextRoles = new Set<AgentRole>();

      for (const def of definitions) {
        if (!def.enabled) continue;
        nextRoles.add(def.role);
        try {
          const instanceId = await this.ensurePoolInstance(def);
          const prev = this.entries.get(def.role);
          // 先停旧（解订阅），再起新（建订阅）：同一 role 任意时刻单订阅。
          if (prev) await prev.runtime.stop();
          const runtime = new AgentRuntime(def, getRoleHandler(def.role), { instanceId });
          await runtime.start();
          this.entries.set(def.role, { runtime, instanceId, role: def.role });
        } catch (err) {
          console.warn(
            `[A2APool] reload: failed to (re)start role=${def.role}, keeping previous:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }

      // 配置里已消失的 role：停掉并移除。
      for (const [role, entry] of [...this.entries.entries()]) {
        if (!nextRoles.has(role)) {
          await entry.runtime.stop().catch(() => {});
          this.entries.delete(role);
        }
      }

      if (!this.started) {
        this.started = true;
        this.startConfigWatcher();
      }
      // reload 成功 → 更新 watcher 的 lastHash，避免本次写盘自己再触发一轮。
      this.configWatcher?.setLastHash(await computeConfigHash());
    } catch (err) {
      console.warn(
        "[A2APool] reload failed; keeping previous pool:",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      this.reloading = false;
    }
    return { before, after: this.entries.size };
  }

  private startConfigWatcher(): void {
    if (this.configWatcher) return;
    this.configWatcher = startWorkspaceConfigWatcher(async () => {
      await this.reload();
    });
  }

  private stopConfigWatcher(): void {
    if (this.configWatcher) {
      this.configWatcher.stop();
      this.configWatcher = null;
    }
  }

  getInstanceIdForRole(role: AgentRole): string {
    const entry = this.entries.get(role);
    if (!entry) {
      throw new Error(`A2A pool has no runtime for role=${role}. Is the agent enabled?`);
    }
    return entry.instanceId;
  }

  hasRole(role: AgentRole): boolean {
    return this.entries.has(role);
  }

  getViews(): Array<{
    role: AgentRole;
    instanceId: string;
    definitionId: string;
    name: string;
    version: string;
    status: "idle" | "running" | "error" | "stopped";
  }> {
    return [...this.entries.values()].map((e) => ({
      role: e.role,
      instanceId: e.instanceId,
      definitionId: e.runtime.definition.id,
      name: e.runtime.definition.name,
      version: e.runtime.definition.version,
      status: e.runtime.instance.status,
    }));
  }

  private async ensurePoolInfrastructure(): Promise<void> {
    const db = await getDb();
    const wsRows = await db
      .select()
      .from(workspace)
      .where(eq(workspace.id, A2A_POOL_WORKSPACE_ID))
      .limit(1);
    if (!wsRows[0]) {
      await db.insert(workspace).values({
        id: A2A_POOL_WORKSPACE_ID,
        name: "A2A Pool",
        owner: "system",
      });
    }

    const projRows = await db
      .select()
      .from(project)
      .where(eq(project.id, A2A_POOL_PROJECT_ID))
      .limit(1);
    if (!projRows[0]) {
      await db.insert(project).values({
        id: A2A_POOL_PROJECT_ID,
        workspaceId: A2A_POOL_WORKSPACE_ID,
        name: "A2A Pool Project",
        marketScope: "GLOBAL",
        status: "active",
      });
    }

    const wfRows = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, A2A_POOL_WORKFLOW_ID))
      .limit(1);
    if (!wfRows[0]) {
      await db.insert(workflowRun).values({
        id: A2A_POOL_WORKFLOW_ID,
        projectId: A2A_POOL_PROJECT_ID,
        goal: "Long-lived A2A agent pool instances",
        mode: "research",
        source: "manual",
        status: "running",
        loopKind: "native",
        executionPath: "a2a",
        loopOptionsJson: {},
      });
    }
  }

  private async loadDefinitions(): Promise<RuntimeAgentDefinition[]> {
    const db = await getDb();
    const dbDefs = await db.select().from(agentDefinition);
    if (dbDefs.length === 0) {
      return SEED_AGENT_DEFINITIONS.filter((d) => d.enabled);
    }
    return dbDefs
      .map(
        (d): RuntimeAgentDefinition => ({
          id: d.id,
          role: d.role,
          name: d.name,
          version: d.version,
          systemPrompt: d.systemPrompt,
          tools: d.toolsJson as string[],
          mcpServers: d.mcpServersJson as string[],
          skills: d.skillsJson as string[],
          subscriptions: d.subscriptionsJson as RuntimeAgentDefinition["subscriptions"],
          llmProvider: d.llmProvider,
          llmConfig: parseLlmConfigJson(d.llmConfigJson),
          maxIterations: d.maxIterations,
          sandboxPolicyId: d.sandboxPolicyId,
          enabled: Boolean(d.enabled),
        })
      )
      .filter((d) => d.enabled);
  }

  private async ensurePoolInstance(def: RuntimeAgentDefinition): Promise<string> {
    const db = await getDb();
    const existing = await db
      .select()
      .from(agentInstance)
      .where(
        and(
          eq(agentInstance.definitionId, def.id),
          eq(agentInstance.workflowRunId, A2A_POOL_WORKFLOW_ID)
        )
      )
      .limit(1);
    if (existing[0]) return existing[0].id;

    const id = randomUUID();
    await db.insert(agentInstance).values({
      id,
      definitionId: def.id,
      workflowRunId: A2A_POOL_WORKFLOW_ID,
      status: "running",
      currentIteration: 0,
      startedAt: new Date().toISOString(),
    });
    return id;
  }
}

let pool: A2APool | null = null;

export function getA2APool(): A2APool {
  if (!pool) pool = new A2APool();
  return pool;
}
