/**
 * Bind Bun workflow_run ↔ Rust Core session (loop_options_json.primeCore).
 */

import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";

export type PrimeCoreBinding = {
  sessionId: string;
  agentSpecId: string;
  agentInstanceId?: string;
  syncedAtMs?: number;
};

export function readPrimeCoreBinding(
  loopOptions: Record<string, unknown> | null | undefined
): PrimeCoreBinding | null {
  const raw = loopOptions?.primeCore;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const sessionId = typeof o.sessionId === "string" ? o.sessionId : "";
  const agentSpecId = typeof o.agentSpecId === "string" ? o.agentSpecId : "";
  if (!sessionId || !agentSpecId) return null;
  return {
    sessionId,
    agentSpecId,
    ...(typeof o.agentInstanceId === "string"
      ? { agentInstanceId: o.agentInstanceId }
      : {}),
    ...(typeof o.syncedAtMs === "number" ? { syncedAtMs: o.syncedAtMs } : {}),
  };
}

export async function writePrimeCoreBinding(
  workflowRunId: string,
  binding: PrimeCoreBinding
): Promise<void> {
  const db = await getDb();
  const rows = await db
    .select({ loopOptionsJson: workflowRun.loopOptionsJson })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  const prev = (rows[0]?.loopOptionsJson as Record<string, unknown> | null) ?? {};
  await db
    .update(workflowRun)
    .set({
      loopOptionsJson: {
        ...prev,
        primeCore: {
          sessionId: binding.sessionId,
          agentSpecId: binding.agentSpecId,
          ...(binding.agentInstanceId
            ? { agentInstanceId: binding.agentInstanceId }
            : {}),
          syncedAtMs: binding.syncedAtMs ?? Date.now(),
          backend: "rust",
        },
      } as never,
    })
    .where(eq(workflowRun.id, workflowRunId));
}
