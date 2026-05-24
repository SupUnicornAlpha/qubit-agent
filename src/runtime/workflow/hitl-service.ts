import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowHitlRequest, workflowRun } from "../../db/sqlite/schema";
import type { LoopOptionsJson } from "../../types/loop";
import { parseLoopOptionsJson } from "../../types/loop";
import { graphRunner } from "../langgraph/graph-factory";
import { stepStreamBus } from "../langgraph/event-stream";
import type { StepStreamEvent } from "../langgraph/state";
import {
  findPendingAnalystJobByWorkflow,
  resumeAnalystResearchJob,
} from "../msa/analyst-research-jobs";
import { dispatchTaskToRole } from "../agent-pool";

export type HitlScope = "chat_orchestrator" | "team_orchestrator";
export type HitlRequestKind = "tool_call" | "team_research_plan";
export type HitlRequestStatus = "pending" | "approved" | "rejected";

export class HitlAwaitingApprovalError extends Error {
  readonly requestId: string;
  readonly workflowRunId: string;

  constructor(requestId: string, workflowRunId: string, message?: string) {
    super(message ?? "awaiting human approval");
    this.name = "HitlAwaitingApprovalError";
    this.requestId = requestId;
    this.workflowRunId = workflowRunId;
  }
}

export type HitlApprovalPayload = {
  requestId: string;
  decision: "approved" | "rejected";
};

export function parseHitlApproval(raw: unknown): HitlApprovalPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const requestId = typeof o.requestId === "string" ? o.requestId : "";
  const decision = o.decision === "approved" || o.decision === "rejected" ? o.decision : null;
  if (!requestId || !decision) return null;
  return { requestId, decision };
}

/** 对话 orchestrator：工具执行前 HITL（run_analyst_team 走团队编排内 HITL）。 */
export function resolveChatOrchestratorHitl(
  wf: { source: string; mode: string },
  loopOptions: LoopOptionsJson,
  role: string
): boolean {
  if (role !== "orchestrator") return false;
  if (loopOptions.hitlChat === false) return false;
  if (loopOptions.hitlChat === true) return true;
  return wf.source === "chat";
}

/**
 * 团队研究：仅 Orchestrator 规划完成后、分析师并行前 HITL。
 *
 * 默认 opt-in：团队研究面板目前没有内嵌的批准/拒绝按钮，所以仅在
 * `loopOptions.hitlTeam === true` 时启用，避免独立面板触发的工作流
 * 在没有 UI 可介入的情况下被卡死。chat 流如果通过 `run_analyst_team`
 * 跑团队研究，会沿用对话 orchestrator 的 HITL gate。
 */
export function resolveTeamOrchestratorHitl(
  _wf: { source: string; mode: string },
  loopOptions: LoopOptionsJson
): boolean {
  return loopOptions.hitlTeam === true;
}

export function shouldHitlGateToolCall(toolName: string): boolean {
  return toolName !== "run_analyst_team";
}

export async function loadWorkflowLoopContext(workflowRunId: string): Promise<{
  workflow: typeof workflowRun.$inferSelect;
  loopOptions: LoopOptionsJson;
}> {
  const db = await getDb();
  const rows = await db.select().from(workflowRun).where(eq(workflowRun.id, workflowRunId)).limit(1);
  const workflow = rows[0];
  if (!workflow) throw new Error(`workflow_run not found: ${workflowRunId}`);
  return { workflow, loopOptions: parseLoopOptionsJson(workflow.loopOptionsJson) };
}

export async function getHitlRequest(requestId: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowHitlRequest)
    .where(eq(workflowHitlRequest.id, requestId))
    .limit(1);
  return rows[0] ?? null;
}

export async function verifyHitlApproval(
  requestId: string,
  workflowRunId: string
): Promise<{ approved: boolean; rejected: boolean }> {
  const row = await getHitlRequest(requestId);
  if (!row || row.workflowRunId !== workflowRunId) {
    return { approved: false, rejected: false };
  }
  return {
    approved: row.status === "approved",
    rejected: row.status === "rejected",
  };
}

function publishHitlStreamEvent(input: {
  runId: string;
  workflowId: string;
  traceId: string;
  role: string;
  stepIndex: number;
  requestId: string;
  title: string;
  summary: string;
  scope: HitlScope;
  requestKind: HitlRequestKind;
}): void {
  const event: StepStreamEvent = {
    runId: input.runId,
    workflowId: input.workflowId,
    traceId: input.traceId,
    role: input.role,
    type: "hitl_request",
    stepIndex: input.stepIndex,
    ts: Date.now(),
    payload: {
      requestId: input.requestId,
      title: input.title,
      summary: input.summary,
      scope: input.scope,
      requestKind: input.requestKind,
    },
    loopKind: "native",
    source: "native",
  };
  stepStreamBus.publish(event);
}

export async function createHitlRequest(input: {
  workflowRunId: string;
  runId: string;
  traceId: string;
  role: string;
  stepIndex: number;
  agentInstanceId?: string;
  scope: HitlScope;
  requestKind: HitlRequestKind;
  title: string;
  summary: string;
  payloadJson: Record<string, unknown>;
}): Promise<{ id: string }> {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(workflowHitlRequest).values({
    id,
    workflowRunId: input.workflowRunId,
    runId: input.runId,
    agentInstanceId: input.agentInstanceId ?? null,
    stepIndex: input.stepIndex,
    scope: input.scope,
    requestKind: input.requestKind,
    status: "pending",
    title: input.title.slice(0, 500),
    summary: input.summary.slice(0, 8000),
    payloadJson: input.payloadJson,
  });
  await db
    .update(workflowRun)
    .set({ status: "awaiting_approval", endedAt: null })
    .where(eq(workflowRun.id, input.workflowRunId));

  publishHitlStreamEvent({
    runId: input.runId,
    workflowId: input.workflowRunId,
    traceId: input.traceId,
    role: input.role,
    stepIndex: input.stepIndex,
    requestId: id,
    title: input.title,
    summary: input.summary,
    scope: input.scope,
    requestKind: input.requestKind,
  });

  return { id };
}

export async function pauseForTeamOrchestratorHitl(input: {
  workflowRunId: string;
  runId: string;
  traceId: string;
  stepIndex?: number;
  ticker: string;
  planBrief: string;
  slotRoles: string[];
  hitlApproval?: HitlApprovalPayload | null;
}): Promise<void> {
  if (input.hitlApproval?.decision === "rejected") {
    throw new HitlAwaitingApprovalError("", input.workflowRunId, "team orchestrator hitl rejected");
  }
  if (input.hitlApproval?.requestId) {
    const v = await verifyHitlApproval(input.hitlApproval.requestId, input.workflowRunId);
    if (v.approved) return;
    if (v.rejected) {
      throw new HitlAwaitingApprovalError(
        input.hitlApproval.requestId,
        input.workflowRunId,
        "team orchestrator hitl rejected"
      );
    }
  }

  const { workflow, loopOptions } = await loadWorkflowLoopContext(input.workflowRunId);
  if (!resolveTeamOrchestratorHitl(workflow, loopOptions)) return;

  const title = `研究团队 Orchestrator 规划待确认：${input.ticker}`;
  const summary = input.planBrief.slice(0, 6000);
  const { id } = await createHitlRequest({
    workflowRunId: input.workflowRunId,
    runId: input.runId,
    traceId: input.traceId,
    role: "orchestrator",
    stepIndex: input.stepIndex ?? 0,
    scope: "team_orchestrator",
    requestKind: "team_research_plan",
    title,
    summary,
    payloadJson: {
      ticker: input.ticker,
      slotRoles: input.slotRoles,
      planBrief: input.planBrief,
    },
  });
  throw new HitlAwaitingApprovalError(id, input.workflowRunId, title);
}

export async function resolveHitlRequest(input: {
  requestId: string;
  decision: "approved" | "rejected";
  resolvedBy?: string;
}): Promise<{ workflowRunId: string; resumed: boolean; runId?: string }> {
  const db = await getDb();
  const row = await getHitlRequest(input.requestId);
  if (!row) throw new Error("hitl request not found");
  if (row.status !== "pending") {
    throw new Error(`hitl request already ${row.status}`);
  }

  const now = new Date().toISOString();
  await db
    .update(workflowHitlRequest)
    .set({
      status: input.decision,
      resolvedAt: now,
      resolvedBy: input.resolvedBy ?? "user",
    })
    .where(eq(workflowHitlRequest.id, input.requestId));

  if (input.decision === "rejected") {
    await db
      .update(workflowRun)
      .set({ status: "failed", endedAt: now })
      .where(eq(workflowRun.id, row.workflowRunId));
    if (row.scope === "team_orchestrator") {
      const { failAnalystResearchJob } = await import("../msa/analyst-research-jobs");
      const pending = findPendingAnalystJobByWorkflow(row.workflowRunId);
      if (pending) {
        failAnalystResearchJob(pending.jobId, new Error("rejected by human reviewer"));
      }
    }
    return { workflowRunId: row.workflowRunId, resumed: false };
  }

  await db
    .update(workflowRun)
    .set({ status: "running", endedAt: null })
    .where(eq(workflowRun.id, row.workflowRunId));

  const wfRows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, row.workflowRunId))
    .limit(1);
  const wf = wfRows[0];
  if (!wf) throw new Error("workflow_run missing after hitl approve");

  // 团队研究：runAnalystTeam 不经 LangGraph，没法走 resumeRoleTask；
  // 改为从 analyst job 缓存里取回原 research_team_execute params，重派给 orchestrator handler，
  // 让它带 hitlApproval 重新跑 runAnalystTeam（pauseForTeamOrchestratorHitl 会因 requestId 已批准直接放行）。
  if (row.scope === "team_orchestrator") {
    const pending = findPendingAnalystJobByWorkflow(row.workflowRunId);
    const resumePayload = pending ? resumeAnalystResearchJob(pending.jobId) : undefined;
    if (!pending || !resumePayload) {
      // 没找到缓存（进程重启等）：把 workflow 标 failed，让用户重新发起。
      await db
        .update(workflowRun)
        .set({ status: "failed", endedAt: new Date().toISOString() })
        .where(eq(workflowRun.id, row.workflowRunId));
      throw new Error(
        "research_team_execute resume payload missing (job state lost); please re-run the analysis"
      );
    }

    await dispatchTaskToRole({
      workflowId: row.workflowRunId,
      role: "orchestrator",
      payload: {
        taskId: randomUUID(),
        taskType: "research_team_execute",
        assignedRole: "orchestrator",
        params: {
          jobId: pending.jobId,
          ticker: resumePayload.ticker,
          scope: resumePayload.scope ?? undefined,
          context: resumePayload.context,
          agentGroupId: resumePayload.agentGroupId ?? undefined,
          analystRoles: resumePayload.analystRoles ?? undefined,
          analystDefinitionIds: resumePayload.analystDefinitionIds ?? undefined,
          hitlApproval: { requestId: input.requestId, decision: "approved" },
        },
      },
    });

    return { workflowRunId: row.workflowRunId, resumed: true, runId: pending.jobId };
  }

  const result = await graphRunner.resumeRoleTask({
    workflowId: row.workflowRunId,
    role: "orchestrator",
    payload: {
      taskId: randomUUID(),
      taskType: "workflow_resume",
      assignedRole: "orchestrator",
      params: {
        workflowRunId: row.workflowRunId,
        goal: wf.goal,
        mode: wf.mode,
        hitlApproval: { requestId: input.requestId, decision: "approved" },
        hitlPayload: row.payloadJson as Record<string, unknown>,
      },
    },
  });

  return { workflowRunId: row.workflowRunId, resumed: result.resumed, runId: result.runId };
}

export async function listPendingHitlRequests(workflowRunId: string) {
  const db = await getDb();
  return db
    .select()
    .from(workflowHitlRequest)
    .where(
      and(
        eq(workflowHitlRequest.workflowRunId, workflowRunId),
        eq(workflowHitlRequest.status, "pending")
      )
    )
    .orderBy(desc(workflowHitlRequest.createdAt));
}
