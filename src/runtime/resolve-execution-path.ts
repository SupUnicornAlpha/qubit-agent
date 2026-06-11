import { eq } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/sqlite/client";
import { workflowRun } from "../db/sqlite/schema";
import type { AgentExecutionPath } from "../types/execution-path";
import { normalizeLoopKind } from "../types/loop";

export interface ExecutionPathContext {
  loopKind?: unknown;
  executionPath?: unknown;
  loopOptionsJson?: unknown;
}

/**
 * Resolve how a native workflow should run agents.
 *
 * 收敛后：native loop 的唯一内部总线是 A2A，恒返回 "a2a"（graph 派发已删除）。
 * 历史 DB 里 executionPath='graph' 的 workflow 也被强制归一到 "a2a"，续跑时走
 * A2A 重放/自研 snapshot 恢复，不再回退 LangGraph。
 *
 * CLI loops (claude_cli / codex_cli) 不经此路径派发（dispatchTaskToRole 直接走
 * getLoopDriver(kind)）；这里对非 native 返回占位 "graph" 仅为类型兼容，不影响实际路由。
 */
export function resolveExecutionPath(ctx: ExecutionPathContext): AgentExecutionPath {
  const loopKind = normalizeLoopKind(ctx.loopKind);
  if (loopKind !== "native") return "graph";
  return "a2a";
}

export async function resolveExecutionPathForWorkflow(
  workflowId: string
): Promise<AgentExecutionPath> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  const row = rows[0];
  if (!row) return config.agentExecutionPath;
  return resolveExecutionPath({
    loopKind: row.loopKind,
    executionPath: row.executionPath,
    loopOptionsJson: row.loopOptionsJson,
  });
}
