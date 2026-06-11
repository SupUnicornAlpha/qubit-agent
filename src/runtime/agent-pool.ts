import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { workflowRun } from "../db/sqlite/schema";
import type { TaskAssignPayload } from "../types/a2a";
import type { AgentRole } from "../types/entities";
import { normalizeLoopKind } from "../types/loop";
import { a2aLoopDriver } from "./a2a/a2a-loop-driver";
import { getA2APool } from "./a2a/a2a-pool";
import { getLoopDriver } from "./loop/registry";

export function getRuntimeAgents() {
  return getA2APool()
    .getViews()
    .map((v) => ({ ...v, executionPath: "a2a" as const }));
}

/**
 * 重载 agent 池配置（.qubit/*.json → DB → 优雅换 runtime）。
 * 统一入口，所有 routes / 测试都走这里，由 A2APool.reload() 真正执行。
 */
export async function reloadAgentPool(): Promise<{ before: number; after: number }> {
  return getA2APool().reload();
}

export async function startAllAgents(): Promise<void> {
  await getA2APool().start();
  if (getA2APool().getViews().length === 0) {
    console.warn("[AgentPool] A2APool empty after start; forcing reload.");
    await getA2APool().reload();
  }
  console.log(`[AgentPool] A2APool=${getA2APool().getViews().length} roles.`);
}

export async function stopAllAgents(): Promise<void> {
  await getA2APool().stop();
  console.log("[AgentPool] A2APool stopped.");
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

  // 收敛后：native loop 的唯一内部总线是 A2A（含 workflow_resume —— 续跑也是真·A2A，
  // 由 orchestrator-handler.handleWorkflowResume 重跑 ReAct / 从自研 snapshot 恢复）。
  // CLI loop（claude_cli / codex_cli）走各自的外部 driver。
  if (kind === "native") {
    return a2aLoopDriver.dispatchTask(params);
  }

  return getLoopDriver(kind).dispatchTask(params);
}
