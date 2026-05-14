import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { workflowRun } from "../db/sqlite/schema";
import type { TaskAssignPayload } from "../types/a2a";
import type { AgentRole } from "../types/entities";
import { normalizeLoopKind } from "../types/loop";
import { graphRunner } from "./langgraph/graph-factory";
import { getLoopDriver } from "./loop/registry";

export function getRuntimeAgents() {
  return graphRunner.getViews();
}

export async function startAllAgents(): Promise<void> {
  await graphRunner.start();
  console.log(`[AgentPool] GraphRunner bootstrapped ${graphRunner.getViews().length} roles.`);
}

export async function stopAllAgents(): Promise<void> {
  await graphRunner.stop();
  console.log("[AgentPool] GraphRunner stopped.");
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
  return getLoopDriver(kind).dispatchTask({
    workflowId: params.workflowId,
    role: params.role,
    payload: params.payload,
    traceId: params.traceId,
  });
}
