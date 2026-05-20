import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentCheckpointSnapshot } from "../../db/sqlite/schema";
import type { AgentGraphState } from "./state";

/**
 * 旁路存储：把 ReAct GraphState 在节点边界序列化一份到 SQLite，
 * 与 LangGraph 自己的 checkpoint blob 互为冗余兜底。
 *
 * 设计取舍：
 *  - `events` 是高频追加日志，太大会撑爆 snapshot_json；这里**只保留最后 50 条**做诊断。
 *  - state_hash 用于幂等检测（同一节点连续重写时不必反复插入）。
 *  - 失败仅打 warn，不打断主流程（LangGraph checkpoint 才是真权威）。
 */

export interface SnapshotPayload {
  runId: string;
  workflowId: string;
  traceId: string;
  agentInstanceId: string;
  stepIndex: number;
  phase: string;
  state: AgentGraphState;
}

const EVENT_TAIL_LIMIT = 50;

function buildSnapshotJson(state: AgentGraphState): Record<string, unknown> {
  const events = state.events ?? [];
  return {
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    agentDefinition: {
      id: state.agentDefinition.id,
      role: state.agentDefinition.role,
      version: state.agentDefinition.version,
      maxIterations: state.agentDefinition.maxIterations,
    },
    inboundMessage: state.inboundMessage,
    iteration: state.iteration,
    plannedAction: state.plannedAction,
    reasonText: state.reasonText,
    toolCalls: state.toolCalls,
    observations: state.observations,
    finalResponse: state.finalResponse,
    contextMemory: state.contextMemory,
    eventsTail: events.slice(-EVENT_TAIL_LIMIT),
    eventsCount: events.length,
  };
}

function hashSnapshot(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
}

export async function writeCheckpointSnapshot(input: SnapshotPayload): Promise<void> {
  try {
    const db = await getDb();
    const snapshotJson = buildSnapshotJson(input.state);
    const stateHash = hashSnapshot(snapshotJson);

    // 节流：同一个 (workflowRunId, stepIndex) 已经写过同 hash 则跳过
    const existing = await db
      .select({ stateHash: agentCheckpointSnapshot.stateHash })
      .from(agentCheckpointSnapshot)
      .where(eq(agentCheckpointSnapshot.runId, input.runId))
      .orderBy(desc(agentCheckpointSnapshot.stepIndex))
      .limit(1);
    if (existing[0]?.stateHash === stateHash) return;

    await db.insert(agentCheckpointSnapshot).values({
      id: randomUUID(),
      workflowRunId: input.workflowId,
      agentInstanceId: input.agentInstanceId,
      runId: input.runId,
      stepIndex: input.stepIndex,
      phase: input.phase,
      iteration: input.state.iteration,
      snapshotJson,
      stateHash,
    });
  } catch (err) {
    console.warn(
      "[agent-checkpoint-snapshot] write skipped:",
      err instanceof Error ? err.message : err
    );
  }
}

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

/** 取某 workflow 最近一份快照。Phase 2.2 提供给运营/兜底恢复使用。 */
export async function loadLatestCheckpointSnapshot(
  workflowRunId: string
): Promise<LoadedSnapshot | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentCheckpointSnapshot)
    .where(eq(agentCheckpointSnapshot.workflowRunId, workflowRunId))
    .orderBy(desc(agentCheckpointSnapshot.stepIndex))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
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
