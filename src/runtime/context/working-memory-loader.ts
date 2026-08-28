/**
 * 从 agent_checkpoint_snapshot 加载 WorkingMemory（TS camelCase 形态）。
 * Extractor pipes 与 Core turn 上下文共用，避免 pipe-loaders 与 prime 双份实现。
 */
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentCheckpointSnapshot } from "../../db/sqlite/schema";
import type { WorkingMemory } from "./types";

function isWorkingMemory(v: unknown): v is WorkingMemory {
  return (
    v != null &&
    typeof v === "object" &&
    "version" in v &&
    Array.isArray((v as WorkingMemory).hypotheses)
  );
}

/** 每个 agent_instance 取最新一步 checkpoint 中的 WorkingMemory。 */
export async function loadLatestWorkingMemoryByInstance(
  workflowRunId: string
): Promise<Map<string, WorkingMemory>> {
  const db = await getDb();
  const rows = await db
    .select({
      agentInstanceId: agentCheckpointSnapshot.agentInstanceId,
      snapshotJson: agentCheckpointSnapshot.snapshotJson,
      stepIndex: agentCheckpointSnapshot.stepIndex,
    })
    .from(agentCheckpointSnapshot)
    .where(eq(agentCheckpointSnapshot.workflowRunId, workflowRunId))
    .orderBy(desc(agentCheckpointSnapshot.stepIndex));

  const out = new Map<string, WorkingMemory>();
  for (const row of rows) {
    if (out.has(row.agentInstanceId)) continue;
    const snap = row.snapshotJson as Record<string, unknown> | null;
    const wm = snap?.workingMemory;
    if (isWorkingMemory(wm)) {
      out.set(row.agentInstanceId, wm);
    }
  }
  return out;
}

/** 按 instance 优先，否则取 map 中唯一一条（常见于单 agent workflow）。 */
export async function loadWorkingMemoryForTurn(input: {
  workflowRunId: string;
  agentInstanceId?: string | null;
}): Promise<WorkingMemory | null> {
  const map = await loadLatestWorkingMemoryByInstance(input.workflowRunId);
  if (map.size === 0) return null;

  const preferred = input.agentInstanceId?.trim();
  if (preferred && map.has(preferred)) {
    return map.get(preferred) ?? null;
  }
  if (map.size === 1) {
    return map.values().next().value ?? null;
  }
  return null;
}
