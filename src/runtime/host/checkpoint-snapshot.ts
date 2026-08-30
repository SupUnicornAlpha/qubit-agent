/**
 * Bun Host checkpoint row helpers (SQLite `agent_checkpoint_snapshot`).
 *
 * Host persistence / hard-delete / restore *detection* — **not** a TS Agent Core.
 * Turn continuity under production is owned by Rust Core sessions/checkpoints.
 * These rows remain for:
 *   - hard-delete cleanup
 *   - detecting whether a prior Host snapshot existed (compensation heuristics)
 *   - ops inspection of legacy rows
 */

import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentCheckpointSnapshot } from "../../db/sqlite/schema";

export interface LoadedSnapshot {
  runId: string;
  workflowRunId: string;
  agentInstanceId: string;
  stepIndex: number;
  phase: string;
  iteration: number;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

function rowToLoadedSnapshot(row: typeof agentCheckpointSnapshot.$inferSelect): LoadedSnapshot {
  return {
    runId: row.runId,
    workflowRunId: row.workflowRunId,
    agentInstanceId: row.agentInstanceId,
    stepIndex: row.stepIndex,
    phase: row.phase,
    iteration: row.iteration,
    snapshot: row.snapshotJson as Record<string, unknown>,
    createdAt: row.createdAt,
  };
}

/** Latest Host snapshot for a workflow (ops / restore heuristics). */
export async function loadLatestCheckpointSnapshot(
  workflowRunId: string
): Promise<LoadedSnapshot | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentCheckpointSnapshot)
    .where(eq(agentCheckpointSnapshot.workflowRunId, workflowRunId))
    .orderBy(desc(agentCheckpointSnapshot.createdAt), desc(agentCheckpointSnapshot.stepIndex))
    .limit(1);
  const row = rows[0];
  return row ? rowToLoadedSnapshot(row) : null;
}

/** Latest Host snapshot for a single runId (multi-slot workflows). */
export async function loadLatestSnapshotByRunId(runId: string): Promise<LoadedSnapshot | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentCheckpointSnapshot)
    .where(eq(agentCheckpointSnapshot.runId, runId))
    .orderBy(desc(agentCheckpointSnapshot.createdAt), desc(agentCheckpointSnapshot.stepIndex))
    .limit(1);
  const row = rows[0];
  return row ? rowToLoadedSnapshot(row) : null;
}

/**
 * Delete all Host snapshot rows for a workflow.
 * Used on new-turn / hard-delete so legacy observation tails cannot pollute a new goal.
 */
export async function deleteCheckpointSnapshotsForWorkflow(workflowRunId: string): Promise<number> {
  try {
    const db = await getDb();
    const deleted = await db
      .delete(agentCheckpointSnapshot)
      .where(eq(agentCheckpointSnapshot.workflowRunId, workflowRunId))
      .returning({ id: agentCheckpointSnapshot.id });
    return deleted.length;
  } catch (err) {
    console.warn(
      "[host/checkpoint-snapshot] delete-for-workflow skipped:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}
