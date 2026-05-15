import { eq } from "drizzle-orm";
import { config } from "../config";
import { getDb } from "../db/sqlite/client";
import { workflowRun } from "../db/sqlite/schema";
import {
  type AgentExecutionPath,
  normalizeExecutionPath,
} from "../types/execution-path";
import { normalizeLoopKind, parseLoopOptionsJson } from "../types/loop";

export interface ExecutionPathContext {
  loopKind?: unknown;
  executionPath?: unknown;
  loopOptionsJson?: unknown;
}

/**
 * Resolve how a native workflow should run agents.
 * CLI loops (claude_cli / codex_cli) always use graph-equivalent external drivers.
 */
export function resolveExecutionPath(ctx: ExecutionPathContext): AgentExecutionPath {
  const loopKind = normalizeLoopKind(ctx.loopKind);
  if (loopKind !== "native") return "graph";

  const opts = parseLoopOptionsJson(ctx.loopOptionsJson);
  if (opts.executionPath) return opts.executionPath;

  if (ctx.executionPath != null && ctx.executionPath !== "") {
    return normalizeExecutionPath(ctx.executionPath);
  }

  return config.agentExecutionPath;
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
