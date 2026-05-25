import { createHash, randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, ne } from "drizzle-orm";
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
import { HitlAwaitingApprovalError } from "../workflow/hitl-service";
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
import { getCheckpointSaver } from "./sqlite-checkpoint-saver";
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
  /** 上一次成功 reload 时 .qubit/agents.json + sandbox.json 的内容哈希；mtime 跳但内容没变就不再 reload */
  private lastConfigHash: string | null = null;

  async start(): Promise<void> {
    if (this.started) return;
    const next = await this.buildNextSnapshot();
    this.definitions = next.definitions;
    this.views = next.views;
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

  /**
   * Reload：原子换入——先在内存里构建新的 definitions/views 快照，构建成功后一把替换。
   * 这样 watcher 抖动或 `.qubit/loop-runs/...` 噪声触发 reload 时，
   * GET /api/v1/agents 不会再短暂返回空池（修复"Graph 长驻池又空了"）。
   * 失败时旧快照保持原样，避免半成品状态。
   */
  async reload(): Promise<{ before: number; after: number }> {
    const before = this.getViews().length;
    try {
      const next = await this.buildNextSnapshot();
      this.definitions = next.definitions;
      this.views = next.views;
      // 成功 reload 后记下本次 .qubit 内容指纹；下一次 watcher 抖动若指纹未变将直接跳过整池 reload。
      this.lastConfigHash = (await this.computeConfigHash()) ?? this.lastConfigHash;
      if (!this.started) {
        this.started = true;
        this.startConfigWatcher();
      }
    } catch (err) {
      console.warn(
        "[GraphRunner] reload failed; keeping previous snapshot:",
        err instanceof Error ? err.message : String(err)
      );
    }
    return { before, after: this.getViews().length };
  }

  /**
   * 读取 .qubit 配置 + DB（不修改 this.* 任何字段），返回一份完整的 definitions+views 快照。
   * 调用方决定何时换入，从而避免 reload 中间窗口被外部观察到空池。
   */
  private async buildNextSnapshot(): Promise<{
    definitions: Map<AgentRole, RuntimeAgentDefinition>;
    views: Map<AgentRole, GraphAgentView>;
  }> {
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

    const definitions = new Map<AgentRole, RuntimeAgentDefinition>();
    const views = new Map<AgentRole, GraphAgentView>();
    for (const def of sourceDefs) {
      definitions.set(def.role, def);
      views.set(def.role, {
        instanceId: `graph-${def.role}`,
        definitionId: def.id,
        role: def.role,
        name: def.name,
        version: def.version,
        status: "running",
      });
    }
    return { definitions, views };
  }

  getViews(): GraphAgentView[] {
    return [...this.views.values()];
  }

  /**
   * 只读 DB 拿单角色的 enabled definition（不触发 .qubit/agents.json 写、不抢锁）。
   * 用于 runRoleTask 在 ensureReady 撞锁后做的最终兜底，避免 "No graph definition" 错误。
   */
  private async fastResolveDefinitionFromDb(
    role: AgentRole
  ): Promise<RuntimeAgentDefinition | undefined> {
    try {
      const db = await getDb();
      const rows = await db
        .select()
        .from(agentDefinition)
        .where(eq(agentDefinition.role, role))
        .limit(1);
      const row = rows[0];
      if (!row || !row.enabled) return undefined;
      return {
        id: row.id,
        role: row.role,
        name: row.name,
        version: row.version,
        systemPrompt: row.systemPrompt,
        tools: row.toolsJson as string[],
        mcpServers: row.mcpServersJson as string[],
        skills: row.skillsJson as string[],
        subscriptions: row.subscriptionsJson as RuntimeAgentDefinition["subscriptions"],
        llmProvider: row.llmProvider,
        maxIterations: row.maxIterations,
        sandboxPolicyId: row.sandboxPolicyId,
        enabled: Boolean(row.enabled),
      };
    } catch (err) {
      console.warn(
        `[GraphRunner] fastResolveDefinitionFromDb(${role}) failed:`,
        err instanceof Error ? err.message : String(err)
      );
      return undefined;
    }
  }

  /**
   * 派发前确保已从 DB 加载角色定义（避免 HTTP 已就绪但 Agent 池未 warm-up）。
   * 撞到 SQLITE_BUSY 时做有界重试（指数退避），避免 watcher 抖动+并发请求导致
   * `runRoleTask` 拿到空 definitions 直接报 "No graph definition for role=..."。
   */
  async ensureReady(requiredRole?: AgentRole): Promise<void> {
    const needsWarmup = () => {
      const missingRole = requiredRole != null && !this.definitions.has(requiredRole);
      return !this.started || this.definitions.size === 0 || missingRole;
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      if (!needsWarmup()) return;
      try {
        if (this.started) await this.reload();
        else await this.start();
      } catch (err) {
        if (attempt === 2) throw err;
      }
      if (!needsWarmup()) return;
      await new Promise((res) => setTimeout(res, 80 * (attempt + 1)));
    }
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

  /**
   * 只关心 .qubit/ 顶层的几份配置（agents.json / sandbox.json / model.json 等），
   * 忽略 loop-runs/<workflowId>/*.json 这类执行 artifacts；
   * macOS 的 fsevents 即便 recursive:false 也会把子目录写入冒泡到这里（fileName 形如
   * "loop-runs/<id>/qubit-mcp-bridge.json"），过去会无意义地触发整池 reload。
   */
  private static readonly WORKSPACE_CONFIG_WATCH_ALLOW = new Set([
    "agents.json",
    "sandbox.json",
    "model.json",
    "debate.json",
    "risk.json",
    "execution-safety.json",
  ]);

  private startConfigWatcher(): void {
    if (this.configWatcher) return;
    this.configWatcher = watch(".qubit", { recursive: false }, (_, fileName) => {
      if (!fileName || !fileName.endsWith(".json")) return;
      if (fileName.includes("/") || fileName.includes("\\")) return; // 拒绝子目录冒泡
      if (!GraphRunner.WORKSPACE_CONFIG_WATCH_ALLOW.has(fileName)) return;
      if (this.reloadTimer) clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => {
        void this.reloadFromWatcherIfContentChanged();
      }, 250);
    });
  }

  /** 计算 agents.json + sandbox.json 的内容指纹；mtime 跳但内容相同的情况就不会触发 reload。 */
  private async computeConfigHash(): Promise<string | null> {
    try {
      const root = process.cwd();
      const agentsPath = join(root, ".qubit", "agents.json");
      const sandboxPath = join(root, ".qubit", "sandbox.json");
      const [a, s] = await Promise.all([
        readFile(agentsPath, "utf-8").catch(() => ""),
        readFile(sandboxPath, "utf-8").catch(() => ""),
      ]);
      const h = createHash("sha1");
      h.update(a);
      h.update("|");
      h.update(s);
      return h.digest("hex");
    } catch {
      return null;
    }
  }

  private async reloadFromWatcherIfContentChanged(): Promise<void> {
    const hash = await this.computeConfigHash();
    if (hash && this.lastConfigHash === hash) {
      // mtime 抖动但内容没变（macOS APFS 经常这样），不必整池 reload。
      return;
    }
    await this.reloadFromWatcher();
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
    await this.ensureReady(params.role);
    let def = this.definitions.get(params.role);
    if (!def) {
      // 最后兜底：直接读 DB 单条记录（不抢 .qubit JSON 写锁），插入到 definitions/views，
      // 解决 ensureReady 撞 SQLITE_BUSY 后仍拿不到 def 的极端时序。
      def = await this.fastResolveDefinitionFromDb(params.role);
      if (def) {
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
    }
    if (!def) {
      throw new Error(
        `No graph definition for role=${params.role} (enabled definition missing in DB). ` +
          `Try POST /api/v1/agents/reload or restart the backend.`
      );
    }

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

  /**
   * 续跑：用 workflowId 作为 LangGraph thread_id，从最近一次 checkpoint 继续。
   * - 若无 checkpoint，将回退到一次干净启动；
   * - 复用最后一个未结束的 agent_instance（若存在），否则新建。
   */
  async resumeRoleTask(params: {
    workflowId: string;
    role?: AgentRole;
    payload?: TaskAssignPayload;
    traceId?: string;
  }): Promise<{ runId: string; resumed: boolean }> {
    const db = await getDb();

    const wfRows = await db
      .select()
      .from(workflowRun)
      .where(eq(workflowRun.id, params.workflowId))
      .limit(1);
    const wf = wfRows[0];
    if (!wf) throw new Error(`workflow_run not found: ${params.workflowId}`);

    const tuple = await getCheckpointSaver().getTuple({
      configurable: { thread_id: params.workflowId },
    });
    const hasCheckpoint = Boolean(tuple);

    // 复用未结束的 agent_instance；若无则下面 executeAgentReact 会自动新建。
    const aiRows = await db
      .select()
      .from(agentInstance)
      .where(
        and(eq(agentInstance.workflowRunId, params.workflowId), ne(agentInstance.status, "stopped"))
      )
      .orderBy(desc(agentInstance.startedAt))
      .limit(1);
    const reuseInstanceId = aiRows[0]?.id;

    // 没有显式 role/payload 时从既有 agent_instance.definitionId 回推 role
    let def: RuntimeAgentDefinition | undefined;
    if (params.role) {
      def = this.definitions.get(params.role);
    } else if (aiRows[0]?.definitionId) {
      const defRow = await db
        .select()
        .from(agentDefinition)
        .where(eq(agentDefinition.id, aiRows[0].definitionId))
        .limit(1);
      if (defRow[0]) {
        def = this.definitions.get(defRow[0].role) ?? undefined;
      }
    }
    if (!def) def = this.definitions.get("orchestrator");
    if (!def) {
      throw new Error("resumeRoleTask: no resolvable agent definition (orchestrator missing)");
    }

    const runId = randomUUID();
    const traceId = params.traceId ?? randomUUID();
    const payload: TaskAssignPayload = params.payload ?? {
      taskId: randomUUID(),
      taskType: "workflow_resume",
      assignedRole: def.role,
      params: { workflowRunId: params.workflowId, goal: wf.goal, mode: wf.mode },
    };

    void this.executeGraph({
      runId,
      traceId,
      def,
      workflowId: params.workflowId,
      payload,
      agentInstanceId: reuseInstanceId,
      resume: hasCheckpoint,
    });
    return { runId, resumed: hasCheckpoint };
  }

  private async executeGraph(params: {
    runId: string;
    traceId: string;
    def: RuntimeAgentDefinition;
    workflowId: string;
    payload: TaskAssignPayload;
    /** Resume 时复用既有 agent_instance.id；不传则新建。 */
    agentInstanceId?: string;
    /** True 表示从 LangGraph checkpoint 续跑。 */
    resume?: boolean;
  }): Promise<void> {
    const db = await getDb();
    const agentInstanceId = params.agentInstanceId ?? randomUUID();
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
          if (teamErr instanceof HitlAwaitingApprovalError) {
            await db
              .update(workflowRun)
              .set({ status: "awaiting_approval", endedAt: null })
              .where(eq(workflowRun.id, params.workflowId));
            stepStreamBus.publish({
              runId: params.runId,
              workflowId: params.workflowId,
              traceId: params.traceId,
              role: params.def.role,
              type: "final",
              stepIndex: 0,
              ts: Date.now(),
              payload: {
                status: "awaiting_approval",
                hitlRequestId: teamErr.requestId,
                title: teamErr.message,
              },
              loopKind: "native",
              source: "native",
            });
            return;
          }
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
        resume: params.resume === true,
      });
      state = finalState;
      if (terminalStatus === "completed" || terminalStatus === "failed") {
        onWorkflowTerminal(params.workflowId, terminalStatus);
      }
    } catch (err) {
      if (err instanceof HitlAwaitingApprovalError) {
        console.log(
          `[GraphRunner] workflow=${params.workflowId} role=${params.def.role} paused awaiting HITL requestId=${err.requestId}`
        );
        try {
          await db
            .update(workflowRun)
            .set({ status: "awaiting_approval", endedAt: null })
            .where(eq(workflowRun.id, params.workflowId));
        } catch {
          /* ignore */
        }
        stepStreamBus.publish({
          runId: params.runId,
          workflowId: params.workflowId,
          traceId: params.traceId,
          role: params.def.role,
          type: "final",
          stepIndex: state?.iteration ?? 0,
          ts: Date.now(),
          payload: {
            status: "awaiting_approval",
            hitlRequestId: err.requestId,
            title: err.message,
          },
          loopKind: "native",
          source: "native",
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[GraphRunner] workflow=${params.workflowId} role=${params.def.role} task=${params.payload.taskType} FAILED:`,
        err instanceof Error ? (err.stack ?? err.message) : err
      );
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
