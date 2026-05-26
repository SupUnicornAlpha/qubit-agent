import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { workflowRun } from "../db/sqlite/schema";
import type { TaskAssignPayload } from "../types/a2a";
import type { AgentRole } from "../types/entities";
import { normalizeLoopKind } from "../types/loop";
import { a2aLoopDriver } from "./a2a/a2a-loop-driver";
import { getA2APool } from "./a2a/a2a-pool";
import { graphRunner } from "./langgraph/graph-factory";
import { getLoopDriver } from "./loop/registry";
import { resolveExecutionPath } from "./resolve-execution-path";

export function getRuntimeAgents() {
  const graphViews = graphRunner.getViews().map((v) => ({
    ...v,
    executionPath: "graph" as const,
  }));
  const a2aViews = getA2APool()
    .getViews()
    .map((v) => ({ ...v, executionPath: "a2a" as const }));
  return [...graphViews, ...a2aViews];
}

export async function startAllAgents(): Promise<void> {
  await graphRunner.start();
  if (graphRunner.getViews().length === 0) {
    console.warn("[AgentPool] GraphRunner empty after start; forcing reload.");
    await graphRunner.reload();
  }
  await getA2APool().start();
  console.log(
    `[AgentPool] GraphRunner=${graphRunner.getViews().length} roles, A2APool=${getA2APool().getViews().length} roles.`
  );
}

export async function stopAllAgents(): Promise<void> {
  await getA2APool().stop();
  await graphRunner.stop();
  console.log("[AgentPool] GraphRunner and A2APool stopped.");
}

export async function dispatchTaskToRole(params: {
  workflowId: string;
  role: AgentRole;
  payload: TaskAssignPayload;
  traceId?: string;
  senderId?: string;
}): Promise<{ runId: string }> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, params.workflowId))
    .limit(1);
  const kind = normalizeLoopKind(rows[0]?.loopKind);
  const path = rows[0]
    ? resolveExecutionPath({
        loopKind: rows[0].loopKind,
        executionPath: rows[0].executionPath,
        loopOptionsJson: rows[0].loopOptionsJson,
      })
    : "graph";

  // P2-A Batch 2：续跑路径不再硬编码走 graphRunner。
  //
  // 历史行为（已废止）：任何 workflow_resume 都强制走 graphRunner，理由是"只有
  // LangGraph 有 checkpointer"。但这会让原本 a2a 的 workflow 被静默切换到 graph
  // 路径，破坏 A2A 自洽性 —— A2A 是事件驱动的多 agent 总线，不应该被迫退化成
  // graph state machine。
  //
  // 新行为：a2a workflow 的 resume = 重新派发一条 TASK_ASSIGN(workflow_resume) 给
  // orchestrator，由 orchestrator-handler.handleWorkflowResume 按 path 自行选择
  // graphRunner.resumeRoleTask 还是 runA2aReactTaskAssign（详见该 handler）。这样
  // graph workflow 续跑路径保持不变，a2a workflow 续跑也是真·A2A。
  if (params.payload.taskType === "workflow_resume" && kind === "native" && path === "graph") {
    return graphRunner.resumeRoleTask({
      workflowId: params.workflowId,
      role: params.role,
      payload: params.payload,
      ...(params.traceId ? { traceId: params.traceId } : {}),
    });
  }

  if (path === "a2a" && kind === "native") {
    return a2aLoopDriver.dispatchTask({
      workflowId: params.workflowId,
      role: params.role,
      payload: params.payload,
      traceId: params.traceId,
    });
  }

  return getLoopDriver(kind).dispatchTask({
    workflowId: params.workflowId,
    role: params.role,
    payload: params.payload,
    traceId: params.traceId,
  });
}
