import { randomUUID } from "node:crypto";
import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";
import { resolveResearchScope, type ResearchScopeInput } from "../../types/research-scope";
import { stepStreamBus } from "../langgraph/event-stream";
import type { StepStreamEvent } from "../langgraph/state";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { HitlAwaitingApprovalError } from "../workflow/hitl-service";
import type { HitlApprovalPayload } from "../workflow/hitl-service";
import { setWorkflowState } from "../workflow/workflow-state-machine";
import {
  completeAnalystResearchJob,
  failAnalystResearchJob,
  getAnalystResearchJob,
  pauseAnalystResearchJobForHitl,
  registerAnalystResearchJob,
} from "./analyst-research-jobs";
import { RESEARCH_TEAM_SLOT_SET, runAnalystTeam, type AnalystTeamResult } from "./analyst-team";

export type ParsedResearchTeamExecute = {
  jobId: string;
  ticker: string;
  scope?: ResearchScopeInput | null;
  context?: string;
  analystDefinitionIds?: string[];
  analystRoles?: AgentRole[];
};

export type ResearchTeamExecuteParseResult =
  | { ok: true; params: ParsedResearchTeamExecute }
  | { ok: false; jobId: string; error: Error };

export function parseResearchTeamExecutePayload(
  payload: TaskAssignPayload
): ResearchTeamExecuteParseResult {
  const pr = payload.params as Record<string, unknown>;
  const jobId = typeof pr.jobId === "string" ? pr.jobId : "";
  const ticker = typeof pr.ticker === "string" ? pr.ticker.trim() : "";
  const scope = (pr.scope as ResearchScopeInput | null | undefined) ?? undefined;
  const resolved = resolveResearchScope({ ticker, scope });

  if (!jobId || (!ticker && !scope && resolved.primarySymbol === "UNKNOWN")) {
    return {
      ok: false,
      jobId,
      error: new Error("research_team_execute requires params.jobId and params.ticker or scope"),
    };
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

  const context = typeof pr.context === "string" ? pr.context : undefined;

  return {
    ok: true,
    params: {
      jobId,
      ticker: ticker || resolved.primarySymbol,
      scope,
      context,
      analystDefinitionIds,
      analystRoles,
    },
  };
}

export async function failResearchTeamExecuteJob(jobId: string, error: unknown): Promise<void> {
  if (!jobId) return;
  await failAnalystResearchJob(
    jobId,
    error instanceof Error ? error : new Error(String(error))
  );
}

/** 运行研究团队并标记 job 完成（不含 workflow / A2A 消息副作用） */
export async function executeResearchTeamWorkflow(input: {
  workflowRunId: string;
  params: ParsedResearchTeamExecute;
  hitlApproval?: HitlApprovalPayload | null;
}): Promise<AnalystTeamResult> {
  const teamResult = await runAnalystTeam({
    workflowRunId: input.workflowRunId,
    ticker: input.params.ticker,
    scope: input.params.scope,
    context: input.params.context,
    analystRoles: input.params.analystRoles,
    analystDefinitionIds: input.params.analystDefinitionIds,
    hitlApproval: input.hitlApproval ?? null,
  });
  await completeAnalystResearchJob(input.params.jobId, teamResult);
  return teamResult;
}

/**
 * 从 ReAct `run_analyst_team` 工具参数构建与 `research_team_execute` 等价的 parsed payload。
 */
export function buildParsedResearchTeamFromToolParams(input: {
  workflowRunId: string;
  params: Record<string, unknown>;
  inboundPayload?: Record<string, unknown>;
  jobId?: string;
}): ParsedResearchTeamExecute {
  const pr = input.params;
  const inbound = input.inboundPayload ?? {};
  const ticker =
    String(pr.ticker ?? inbound["ticker"] ?? "").trim() || "UNKNOWN";
  const scopeRaw = pr.scope ?? inbound["scope"];
  const scope =
    scopeRaw && typeof scopeRaw === "object" && !Array.isArray(scopeRaw)
      ? (scopeRaw as ResearchScopeInput)
      : undefined;

  const rolesRaw = pr.analyst_roles ?? pr.analystRoles;
  const analystRoles =
    Array.isArray(rolesRaw) && rolesRaw.length > 0
      ? (rolesRaw.filter(
          (r): r is AgentRole => typeof r === "string" && RESEARCH_TEAM_SLOT_SET.has(r)
        ) as AgentRole[])
      : undefined;

  const defIdsRaw = pr.analyst_definition_ids ?? pr.analystDefinitionIds;
  const analystDefinitionIds =
    Array.isArray(defIdsRaw) && defIdsRaw.length > 0
      ? defIdsRaw.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : undefined;

  const context = String(pr.context ?? inbound["goal"] ?? "").trim() || undefined;

  return {
    jobId: input.jobId ?? randomUUID(),
    ticker,
    scope,
    context,
    analystDefinitionIds,
    analystRoles,
  };
}

/**
 * Orchestrator 研究团队统一入口：`research_team_execute` 任务与 `run_analyst_team` 工具
 * 均经 `runTeamResearchAndPersist` 写 workflow 状态 / SSE / analyst job。
 */
export async function runResearchTeamFromOrchestrator(input: {
  workflowRunId: string;
  runId: string;
  traceId: string;
  parsed: ParsedResearchTeamExecute;
  hitlApproval?: HitlApprovalPayload | null;
  /** ReAct 工具路径：若无 job 则自动 register */
  ensureJob?: boolean;
}): Promise<AnalystTeamResult> {
  if (input.ensureJob) {
    const existing = await getAnalystResearchJob(input.parsed.jobId);
    if (!existing) {
      await registerAnalystResearchJob(input.parsed.jobId, {
        status: "running",
        workflowRunId: input.workflowRunId,
        ticker: input.parsed.ticker,
        startedAt: Date.now(),
      });
    }
  }

  const outcome = await runTeamResearchAndPersist({
    workflowRunId: input.workflowRunId,
    runId: input.runId,
    traceId: input.traceId,
    parsed: input.parsed,
    hitlApproval: input.hitlApproval ?? null,
  });

  if (outcome.kind === "completed") return outcome.teamResult;
  if (outcome.kind === "awaiting_approval") {
    throw new HitlAwaitingApprovalError(
      outcome.requestId,
      input.workflowRunId,
      outcome.title
    );
  }
  throw outcome.error;
}

// ─── 统一短路 helper ─────────────────────────────────────────────────────────
//
// 旧版本：`graph-factory.ts` 与 `role-handlers.ts` **各抄了一遍** "执行研究团队 →
// 处理 HITL pause → 写 workflow_run 状态 → 发 SSE final" 的代码（详见 docs/
// AGENT_STABILITY_REVIEW.md §1.1 与第二轮 review 的 P0-1）。
//
// 抄两遍带来的真实后果：
//   - HITL pause 字段对不齐 → "approve → 又弹一次 HITL → ..." 死循环；
//   - workflow_run.status 写法漂移 → 前端看到 status=running 但 HITL 卡片永远不弹；
//   - 后续要在两份代码里同步加 idempotency / 日志 / SSE 字段 → 永远会漏一份。
//
// 该 helper 是 **唯一的真理源**：所有 `research_team_execute` 类型的任务都必须经过这里
// 完成"执行 + 状态持久化 + HITL 暂停"。caller（GraphRunner / A2A orchestratorHandler）
// 只负责自己生命周期内的副作用（agent_instance / TASK_RESULT 消息）。

export type ResearchTeamOutcome =
  | { kind: "completed"; teamResult: AnalystTeamResult }
  | { kind: "awaiting_approval"; requestId: string; title: string }
  | { kind: "failed"; error: Error };

/**
 * 可注入依赖。生产代码不传，使用默认实现；测试时注入 mock 即可。
 * 不引入完整 DI，仅暴露这几个 side-effect 边界。
 */
export interface RunTeamResearchPersistDeps {
  /** 跑 LLM/wave 的核心；默认 `executeResearchTeamWorkflow` */
  execute?: typeof executeResearchTeamWorkflow;
  /**
   * 将 workflow_run.status 写到 DB；默认走 drizzle。
   *
   * "running" 是 2026-05-26 新增：研究团队 graph 短路路径既不经
   * `executeAgentReact` 也不经 `a2aLoopDriver.dispatchTask`，没人把 status
   * 从 `pending` 切到 `running`，导致前端 sidebar 一直显示 pending。helper
   * 是唯一真理源，所以在这里补这一次幂等写入。
   */
  setWorkflowStatus?: (
    workflowRunId: string,
    status: "completed" | "failed" | "awaiting_approval" | "running",
  ) => Promise<void>;
  /** SSE 事件汇；默认 `stepStreamBus.publish` */
  publishEvent?: (event: StepStreamEvent) => void;
  /** 工作流终止 hook；默认 `onWorkflowTerminal` */
  onTerminal?: (workflowId: string, status: "completed" | "failed") => void;
  /** 暂停 in-memory analyst job 并缓存 resumePayload；默认 `pauseAnalystResearchJobForHitl` */
  pauseJob?: typeof pauseAnalystResearchJobForHitl;
  /** 把 analyst job 标 failed；默认 `failResearchTeamExecuteJob` */
  failJob?: typeof failResearchTeamExecuteJob;
}

async function defaultSetWorkflowStatus(
  workflowRunId: string,
  status: "completed" | "failed" | "awaiting_approval" | "running",
): Promise<void> {
  await setWorkflowState(workflowRunId, status, { reason: "research-team-execute" });
}

/**
 * 统一执行 + 持久化研究团队任务。三种 outcome 都已把 DB / SSE / in-memory job 状态写回，
 * caller 只需根据 outcome.kind 决定自己侧的副作用（如 agent_instance / TASK_RESULT）。
 */
export async function runTeamResearchAndPersist(
  input: {
    workflowRunId: string;
    runId: string;
    traceId: string;
    parsed: ParsedResearchTeamExecute;
    hitlApproval: HitlApprovalPayload | null;
  },
  deps: RunTeamResearchPersistDeps = {},
): Promise<ResearchTeamOutcome> {
  const execute = deps.execute ?? executeResearchTeamWorkflow;
  const setStatus = deps.setWorkflowStatus ?? defaultSetWorkflowStatus;
  const publish = deps.publishEvent ?? ((evt) => stepStreamBus.publish(evt));
  const terminal = deps.onTerminal ?? onWorkflowTerminal;
  const pauseJob = deps.pauseJob ?? pauseAnalystResearchJobForHitl;
  const failJob = deps.failJob ?? failResearchTeamExecuteJob;

  try {
    /**
     * 2026-05-26 修复 "在跑但 sidebar 一直显示 pending"：
     *   - Graph 短路路径（research_team_execute）不经 executeAgentReact，
     *     也不经 a2aLoopDriver.dispatchTask，所以没人把 status 从 pending
     *     切到 running。helper 是唯一真理源，这里补一次。
     *   - 合法迁移：pending → running（首派）、running → running（幂等，
     *     HITL approve 后 orchestrator-handler 会再次走到这里）、
     *     awaiting_approval → running、failed → running（compensation 重试）
     *     都在 ALLOWED_TRANSITIONS 内，不会触发非法 transition warn。
     */
    await setStatus(input.workflowRunId, "running");

    const teamResult = await execute({
      workflowRunId: input.workflowRunId,
      params: input.parsed,
      hitlApproval: input.hitlApproval,
    });
    await setStatus(input.workflowRunId, "completed");
    terminal(input.workflowRunId, "completed");
    publish({
      runId: input.runId,
      workflowId: input.workflowRunId,
      traceId: input.traceId,
      role: "orchestrator",
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
    return { kind: "completed", teamResult };
  } catch (err) {
    if (err instanceof HitlAwaitingApprovalError) {
      await pauseJob(input.parsed.jobId, {
        requestId: err.requestId,
        title: err.message,
        summary: err.message,
        resumePayload: input.parsed,
      });
      console.log(
        `[research-team] workflow=${input.workflowRunId} paused awaiting HITL requestId=${err.requestId} job=${input.parsed.jobId}`,
      );
      await setStatus(input.workflowRunId, "awaiting_approval");
      publish({
        runId: input.runId,
        workflowId: input.workflowRunId,
        traceId: input.traceId,
        role: "orchestrator",
        type: "final",
        stepIndex: 0,
        ts: Date.now(),
        payload: {
          status: "awaiting_approval",
          hitlRequestId: err.requestId,
          title: err.message,
        },
        loopKind: "native",
        source: "native",
      });
      return { kind: "awaiting_approval", requestId: err.requestId, title: err.message };
    }
    const wrapped = err instanceof Error ? err : new Error(String(err));
    console.error(
      `[research-team] workflow=${input.workflowRunId} research_team_execute FAILED:`,
      wrapped.stack ?? wrapped.message,
    );
    await failJob(input.parsed.jobId, wrapped);
    await setStatus(input.workflowRunId, "failed");
    terminal(input.workflowRunId, "failed");
    return { kind: "failed", error: wrapped };
  }
}
