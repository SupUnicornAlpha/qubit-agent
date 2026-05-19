import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { eq } from "drizzle-orm";
import { registerBuiltinConnectors } from "../../connectors/bootstrap";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance, workflowRun } from "../../db/sqlite/schema";
import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { syncWorkspaceConfigToDb } from "../config/config-sync";
import {
  buildDefaultSandboxPoliciesFromDefinitions,
  ensureWorkspaceRuntimeConfigFiles,
  loadWorkspaceRuntimeConfig,
} from "../config/workspace-config";
import {
  executeResearchTeamWorkflow,
  failResearchTeamExecuteJob,
  parseResearchTeamExecutePayload,
} from "../msa/research-team-execute";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";
import type { RuntimeAgentDefinition } from "../types";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { stepStreamBus } from "./event-stream";
import { executeAgentReact } from "./execute-agent-react";
import type { AgentGraphState } from "./state";

void registerBuiltinConnectors();

type GraphAgentView = {
  instanceId: string;
  definitionId: string;
  role: AgentRole;
  name: string;
  version: string;
  status: "idle" | "running" | "error" | "stopped";
};

export class GraphRunner {
  private definitions = new Map<AgentRole, RuntimeAgentDefinition>();
  private views = new Map<AgentRole, GraphAgentView>();
  private started = false;
  private configWatcher: FSWatcher | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private reloading = false;

  async start(): Promise<void> {
    if (this.started) return;
    await this.syncFromWorkspaceConfig();
    const db = await getDb();
    const dbDefs = await db.select().from(agentDefinition);
    const sourceDefs = (
      dbDefs.length
        ? dbDefs.map(
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
              maxIterations: d.maxIterations,
              sandboxPolicyId: d.sandboxPolicyId,
              enabled: Boolean(d.enabled),
            })
          )
        : SEED_AGENT_DEFINITIONS
    ).filter((d) => d.enabled);

    for (const def of sourceDefs) {
      this.definitions.set(def.role, def);
      this.views.set(def.role, {
        instanceId: `graph-${def.role}`,
        definitionId: def.id,
        role: def.role,
        name: def.name,
        version: def.version,
        status: "running",
      });
    }
    this.started = true;
    this.startConfigWatcher();
  }

  async stop(): Promise<void> {
    for (const view of this.views.values()) view.status = "stopped";
    this.stopConfigWatcher();
    this.definitions.clear();
    this.views.clear();
    this.started = false;
  }

  async reload(): Promise<{ before: number; after: number }> {
    const before = this.getViews().length;
    await this.stop();
    await this.start();
    return { before, after: this.getViews().length };
  }

  getViews(): GraphAgentView[] {
    return [...this.views.values()];
  }

  private async syncFromWorkspaceConfig(): Promise<void> {
    const loaded = await loadWorkspaceRuntimeConfig();
    if (loaded.parseError) {
      console.warn(
        "[GraphRunner] workspace .qubit JSON invalid, skipping file→DB sync:",
        loaded.parseError
      );
    }
    if (!loaded.config) {
      await ensureWorkspaceRuntimeConfigFiles({
        definitions: SEED_AGENT_DEFINITIONS,
        policies: buildDefaultSandboxPoliciesFromDefinitions(SEED_AGENT_DEFINITIONS),
      });
      const reloaded = await loadWorkspaceRuntimeConfig();
      if (reloaded.config) {
        await syncWorkspaceConfigToDb(reloaded.config);
      } else if (reloaded.parseError) {
        console.warn(
          "[GraphRunner] workspace still invalid after bootstrap write attempt:",
          reloaded.parseError
        );
      }
      return;
    }
    await syncWorkspaceConfigToDb(loaded.config);
  }

  private startConfigWatcher(): void {
    if (this.configWatcher) return;
    this.configWatcher = watch(".qubit", { recursive: false }, (_, fileName) => {
      if (!fileName || !fileName.endsWith(".json")) return;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        void this.reloadFromWatcher();
      }, 250);
    });
  }

  private stopConfigWatcher(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = null;
    }
  }

  private async reloadFromWatcher(): Promise<void> {
    if (this.reloading) return;
    this.reloading = true;
    try {
      await this.reload();
      console.log("[GraphRunner] workspace config changed, reloaded.");
    } catch (error) {
      console.error("[GraphRunner] workspace config reload failed:", error);
    } finally {
      this.reloading = false;
    }
  }

  async runRoleTask(params: {
    workflowId: string;
    role: AgentRole;
    payload: TaskAssignPayload;
    traceId?: string;
  }): Promise<{ runId: string }> {
    const def = this.definitions.get(params.role);
    if (!def) throw new Error(`No graph definition for role=${params.role}`);

    const runId = randomUUID();
    const traceId = params.traceId ?? randomUUID();
    void this.executeGraph({
      runId,
      traceId,
      def,
      workflowId: params.workflowId,
      payload: params.payload,
    });
    return { runId };
  }

  private async executeGraph(params: {
    runId: string;
    traceId: string;
    def: RuntimeAgentDefinition;
    workflowId: string;
    payload: TaskAssignPayload;
  }): Promise<void> {
    const db = await getDb();
    const agentInstanceId = randomUUID();
    let state: AgentGraphState | undefined;

    const publishError = (message: string, stepIndex: number) => {
      stepStreamBus.publish({
        runId: params.runId,
        workflowId: params.workflowId,
        traceId: params.traceId,
        role: params.def.role,
        type: "error",
        stepIndex,
        ts: Date.now(),
        payload: { error: message },
        loopKind: "native",
        source: "native",
      });
    };

    try {
      /** 研究团队 HTTP 任务：统一走 Orchestrator 派发，在此短路执行，避免绕过编排器 */
      if (
        params.def.role === "orchestrator" &&
        params.payload.taskType === "research_team_execute"
      ) {
        const parsed = parseResearchTeamExecutePayload(params.payload);
        if (!parsed.ok) {
          failResearchTeamExecuteJob(parsed.jobId, parsed.error);
          throw parsed.error;
        }

        await db.insert(agentInstance).values({
          id: agentInstanceId,
          definitionId: params.def.id,
          workflowRunId: params.workflowId,
          status: "running",
          currentIteration: 0,
          startedAt: new Date().toISOString(),
        });

        try {
          const teamResult = await executeResearchTeamWorkflow({
            workflowRunId: params.workflowId,
            params: parsed.params,
          });
          await db
            .update(agentInstance)
            .set({
              status: "stopped",
              endedAt: new Date().toISOString(),
            })
            .where(eq(agentInstance.id, agentInstanceId));
          await db
            .update(workflowRun)
            .set({ status: "completed", endedAt: new Date().toISOString() })
            .where(eq(workflowRun.id, params.workflowId));
          onWorkflowTerminal(params.workflowId, "completed");
          stepStreamBus.publish({
            runId: params.runId,
            workflowId: params.workflowId,
            traceId: params.traceId,
            role: params.def.role,
            type: "final",
            stepIndex: 0,
            ts: Date.now(),
            payload: {
              status: "completed",
              taskType: "research_team_execute",
              fusionId: teamResult.fusionId,
              fusedSignal: teamResult.fusedSignal,
              fusedConfidence: teamResult.fusedConfidence,
            },
            loopKind: "native",
            source: "native",
          });
        } catch (teamErr) {
          failResearchTeamExecuteJob(parsed.params.jobId, teamErr);
          throw teamErr;
        }
        return;
      }

      const { finalState, terminalStatus } = await executeAgentReact({
        runId: params.runId,
        workflowId: params.workflowId,
        traceId: params.traceId,
        def: params.def,
        payload: params.payload,
        receiverAgent: agentInstanceId,
        agentInstanceId,
        streamLoopKind: "native",
        streamSource: "native",
        updateWorkflowStatus: true,
      });
      state = finalState;
      onWorkflowTerminal(params.workflowId, terminalStatus);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      publishError(message, state?.iteration ?? 0);
      try {
        await db
          .update(workflowRun)
          .set({ status: "failed", endedAt: new Date().toISOString() })
          .where(eq(workflowRun.id, params.workflowId));
        onWorkflowTerminal(params.workflowId, "failed");
      } catch {
        // ignore secondary failures
      }
      try {
        await db
          .update(agentInstance)
          .set({
            status: "error",
            endedAt: new Date().toISOString(),
            errorMessage: message.slice(0, 2000),
          })
          .where(eq(agentInstance.id, agentInstanceId));
      } catch {
        // ignore if instance row never committed
      }
    } finally {
      // Defer close so the browser can process the last SSE frame before FIN;
      // otherwise EventSource often fires onerror before the "final" handler runs.
      const rid = params.runId;
      setTimeout(() => stepStreamBus.close(rid), 250);
    }
  }
}

export const graphRunner = new GraphRunner();
