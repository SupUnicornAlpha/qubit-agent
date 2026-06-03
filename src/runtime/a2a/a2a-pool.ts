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

  async start(): Promise<void> {
    if (this.started) return;
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
    console.log(`[A2APool] started ${this.entries.size} role runtimes.`);
  }

  async stop(): Promise<void> {
    for (const entry of this.entries.values()) {
      await entry.runtime.stop();
    }
    this.entries.clear();
    this.started = false;
    console.log("[A2APool] stopped.");
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
