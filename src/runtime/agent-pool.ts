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

  // 续跑请求：无论原 executionPath 是 graph 还是 a2a，都强制走 graphRunner，
  // 因为只有 LangGraph 路径有 checkpointer，可以从断点继续。
  if (params.payload.taskType === "workflow_resume" && kind === "native") {
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
