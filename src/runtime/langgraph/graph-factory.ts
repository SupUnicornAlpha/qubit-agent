import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { END, START, StateGraph } from "@langchain/langgraph";
import { eq } from "drizzle-orm";
import { registerBuiltinConnectors } from "../../connectors/bootstrap";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance, agentStep, workflowRun } from "../../db/sqlite/schema";
import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { syncWorkspaceConfigToDb } from "../config/config-sync";
import {
  buildDefaultSandboxPoliciesFromDefinitions,
  ensureWorkspaceRuntimeConfigFiles,
  loadWorkspaceRuntimeConfig,
} from "../config/workspace-config";
import { completeAnalystResearchJob, failAnalystResearchJob } from "../msa/analyst-research-jobs";
import { RESEARCH_TEAM_SLOT_SET, runAnalystTeam } from "../msa/analyst-team";
import { sandboxExecutor } from "../sandbox-executor";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";
import type { RuntimeAgentDefinition } from "../types";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { stepStreamBus } from "./event-stream";
import { actNode } from "./nodes/act";
import { observeNode } from "./nodes/observe";
import { perceiveNode } from "./nodes/perceive";
import { reasonNode } from "./nodes/reason";
import { type AgentGraphState, type StepStreamEvent, createInitialGraphState } from "./state";

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
      await db.insert(agentInstance).values({
        id: agentInstanceId,
        definitionId: params.def.id,
        workflowRunId: params.workflowId,
        status: "running",
        currentIteration: 0,
        startedAt: new Date().toISOString(),
      });

      /** 研究团队 HTTP 任务：统一走 Orchestrator 派发，在此短路执行，避免绕过编排器 */
      if (
        params.def.role === "orchestrator" &&
        params.payload.taskType === "research_team_execute"
      ) {
        type ResearchTeamExecuteParams = {
          jobId?: string;
          ticker?: string;
          context?: string;
          agentGroupId?: string | null;
          analystDefinitionIds?: string[];
          analystRoles?: string[];
        };
        const pr = params.payload.params as ResearchTeamExecuteParams;
        const jobId = typeof pr.jobId === "string" ? pr.jobId : "";
        const ticker = typeof pr.ticker === "string" ? pr.ticker.trim() : "";
        const context = typeof pr.context === "string" ? pr.context : undefined;
        let agentGroupId: string | null | undefined;
        if ("agentGroupId" in pr) {
          const ag = pr.agentGroupId;
          if (ag === null) agentGroupId = null;
          else if (typeof ag === "string") agentGroupId = ag.trim() || null;
        }
        const rawDefIds = pr.analystDefinitionIds;
        const analystDefinitionIds =
          Array.isArray(rawDefIds) && rawDefIds.length > 0
            ? rawDefIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            : undefined;
        const rawRoles = pr.analystRoles;
        const analystRoles =
          Array.isArray(rawRoles) && rawRoles.length > 0
            ? (rawRoles.filter(
                (r): r is AgentRole => typeof r === "string" && RESEARCH_TEAM_SLOT_SET.has(r)
              ) as AgentRole[])
            : undefined;

        if (!jobId || !ticker) {
          if (jobId) {
            failAnalystResearchJob(jobId, new Error("research_team_execute: missing ticker"));
          }
          throw new Error("research_team_execute requires params.jobId and params.ticker");
        }

        try {
          const teamResult = await runAnalystTeam({
            workflowRunId: params.workflowId,
            ticker,
            context,
            agentGroupId,
            analystRoles,
            analystDefinitionIds,
          });
          completeAnalystResearchJob(jobId, teamResult);
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
          failAnalystResearchJob(jobId, teamErr);
          throw teamErr;
        }
        return;
      }

      const initialState = createInitialGraphState({
        runId: params.runId,
        workflowId: params.workflowId,
        traceId: params.traceId,
        agentDefinition: params.def,
        inboundMessage: {
          messageId: randomUUID(),
          workflowId: params.workflowId,
          traceId: params.traceId,
          senderAgent: "system",
          receiverAgent: agentInstanceId,
          messageType: "TASK_ASSIGN",
          payload: params.payload,
          priority: 50,
          createdAt: new Date().toISOString(),
        },
      });
      state = initialState;

      const emit = (event: StepStreamEvent) => {
        const enriched: StepStreamEvent = { ...event, loopKind: "native", source: "native" };
        state!.events.push(enriched);
        stepStreamBus.publish(enriched);
      };

      const graph = new StateGraph({
        channels: {
          state: {
            value: (x: AgentGraphState, y: Partial<AgentGraphState>) => ({ ...x, ...y }),
            default: () => initialState,
          },
        },
      }) as any;

      graph.addNode("perceive", async (input: { state: AgentGraphState }) => {
        const s = input.state;
        const perceiveStepId = randomUUID();
        await db.insert(agentStep).values({
          id: perceiveStepId,
          agentInstanceId,
          workflowRunId: params.workflowId,
          stepIndex: 0,
          phase: "perceive",
          thought: "Read inbound message and memory context",
          actionType: "memory_read",
          actionJson: { payload: params.payload },
        });
        const partial = await perceiveNode(s);
        return { state: { ...s, ...partial } };
      });

      graph.addNode("reason", async (input: { state: AgentGraphState }) => {
        const nextIteration = input.state.iteration + 1;
        const iterationCheck = await sandboxExecutor.checkIterationLimit({
          runId: params.runId,
          workflowId: params.workflowId,
          traceId: params.traceId,
          agentInstanceId,
          definition: params.def,
          currentIteration: nextIteration,
        });
        if (!iterationCheck.allowed) {
          emit({
            runId: params.runId,
            workflowId: params.workflowId,
            traceId: params.traceId,
            role: params.def.role,
            type: "observe",
            stepIndex: input.state.iteration,
            ts: Date.now(),
            payload: {
              code: "SANDBOX_ITERATION_LIMIT",
              alertType: "iteration_exceeded",
              message: iterationCheck.reason ?? "iteration blocked by sandbox",
            },
          });
          return {
            state: {
              ...input.state,
              finalResponse: {
                status: "terminated",
                reason: "sandbox_iteration_limit",
                iteration: input.state.iteration,
              },
            },
          };
        }
        await db
          .update(agentInstance)
          .set({ currentIteration: nextIteration })
          .where(eq(agentInstance.id, agentInstanceId));
        const reasonStepId = randomUUID();
        await db.insert(agentStep).values({
          id: reasonStepId,
          agentInstanceId,
          workflowRunId: params.workflowId,
          stepIndex: nextIteration,
          phase: "reason",
          thought: "Reasoning with LLM provider",
          actionType: "tool_call",
          actionJson: { llmProvider: params.def.llmProvider },
        });
        const partial = await reasonNode({ ...input.state, iteration: nextIteration }, emit);
        return { state: { ...input.state, iteration: nextIteration, ...partial } };
      });

      graph.addNode("act", async (input: { state: AgentGraphState }) => {
        const s = input.state;
        const actStepId = randomUUID();
        await db.insert(agentStep).values({
          id: actStepId,
          agentInstanceId,
          workflowRunId: params.workflowId,
          stepIndex: s.iteration,
          phase: "act",
          thought: "Execute selected tool",
          actionType: "tool_call",
          actionJson: { plannedAction: s.plannedAction },
        });
        const partial = await actNode(s, emit, agentInstanceId, actStepId);
        return { state: { ...s, ...partial } };
      });

      graph.addNode("observe", async (input: { state: AgentGraphState }) => {
        const s = input.state;
        const partial = await observeNode(s, emit, agentInstanceId);
        return { state: { ...s, ...partial } };
      });

      graph.addNode("finalize", async (input: { state: AgentGraphState }) => {
        const s = input.state;
        const forceLoop = Boolean(params.payload.params?.["forceLoop"]);
        const exceeded = forceLoop && s.iteration >= params.def.maxIterations;
        if (exceeded) {
          emit({
            runId: params.runId,
            workflowId: params.workflowId,
            traceId: params.traceId,
            role: params.def.role,
            type: "observe",
            stepIndex: s.iteration,
            ts: Date.now(),
            payload: {
              code: "MAX_ITERATIONS",
              alertType: "iteration_exceeded",
              message: "graph terminated by max iterations",
            },
          });
        }
        const finalResponse = exceeded
          ? { status: "terminated", reason: "max_iterations", iteration: s.iteration }
          : {
              status: "completed",
              role: params.def.role,
              iteration: s.iteration,
              observation: s.observations.at(-1) ?? {},
            };
        return { state: { ...s, finalResponse } };
      });

      graph.addEdge(START, "perceive");
      graph.addEdge("perceive", "reason");
      graph.addEdge("reason", "act");
      graph.addEdge("act", "observe");
      graph.addConditionalEdges(
        "observe",
        (input: { state: AgentGraphState }) => {
          if (input.state.finalResponse) return "finalize";
          const forceLoop = Boolean(params.payload.params?.["forceLoop"]);
          if (forceLoop && input.state.iteration < params.def.maxIterations) {
            return "reason";
          }
          return "finalize";
        },
        { reason: "reason", finalize: "finalize" }
      );
      graph.addEdge("finalize", END);

      const app = graph.compile();
      const result = (await app.invoke({ state: initialState })) as { state: AgentGraphState };
      state = result.state;

      await db
        .update(agentInstance)
        .set({
          status: "stopped",
          endedAt: new Date().toISOString(),
        })
        .where(eq(agentInstance.id, agentInstanceId));
      const terminalStatus =
        state.finalResponse?.["status"] === "terminated" ? "failed" : "completed";
      await db
        .update(workflowRun)
        .set({
          status: terminalStatus,
          endedAt: new Date().toISOString(),
        })
        .where(eq(workflowRun.id, params.workflowId));
      onWorkflowTerminal(params.workflowId, terminalStatus);

      emit({
        runId: params.runId,
        workflowId: params.workflowId,
        traceId: params.traceId,
        role: params.def.role,
        type: "final",
        stepIndex: state.iteration,
        ts: Date.now(),
        payload: state.finalResponse ?? { status: "completed" },
      });
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
