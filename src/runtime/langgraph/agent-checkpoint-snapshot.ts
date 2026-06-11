import { createHash, randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentCheckpointSnapshot } from "../../db/sqlite/schema";
import type { A2AMessageEnvelope } from "../../types/a2a";
import type { RuntimeAgentDefinition } from "../types";
import { type AgentGraphState, createInitialGraphState } from "./state";

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

/** 取某 workflow 最近一份快照。Phase 2.2 提供给运营/兜底恢复使用。 */
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

/**
 * 取某 runId 最近一份快照。
 *
 * 与 `loadLatestCheckpointSnapshot(workflowRunId)` 的区别 / 为什么需要它：
 *   MSA fan-out 时一个 workflowRunId 下有多个并发 slot，每个 slot 各自一个
 *   独立 `runId`（slot-react 内 randomUUID）。按 workflowRunId 取"最近"会拿到
 *   最后写入的**任意** slot，导致 resume 串台。单 ReAct resume 应按 runId 精确定位。
 *
 * 收敛后这是自研 checkpoint resume 的主入口（替代 LangGraph getTuple）。
 */
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
 * 删除某 workflow 的全部自研快照行。
 *
 * 用于同会话**新一轮用户追问**（workflow_start 而非 resume）：旧 observation /
 * finalResponse 不应污染新 goal，必须把上一轮的 checkpoint 清掉。替代原
 * `clearWorkflowCheckpointForNewTurn` 里删 LangGraph thread 的动作。
 *
 * 返回删除的行数（best-effort 不抛；失败仅 warn，与 writeCheckpointSnapshot 一致）。
 */
export async function deleteCheckpointSnapshotsForWorkflow(
  workflowRunId: string
): Promise<number> {
  try {
    const db = await getDb();
    const deleted = await db
      .delete(agentCheckpointSnapshot)
      .where(eq(agentCheckpointSnapshot.workflowRunId, workflowRunId))
      .returning({ id: agentCheckpointSnapshot.id });
    return deleted.length;
  } catch (err) {
    console.warn(
      "[agent-checkpoint-snapshot] delete-for-workflow skipped:",
      err instanceof Error ? err.message : err
    );
    return 0;
  }
}

export interface RestoredReactState {
  state: AgentGraphState;
  /** 已完成到的 iteration；while 循环应从 iteration+1 的 reason 重入。 */
  resumeIteration: number;
  /** 快照落盘时所处节点阶段（perceive/reason/hitl_gate/act/observe/finalize）。 */
  resumePhase: string;
}

/**
 * 把一份持久化快照反序列化回可续跑的 `AgentGraphState`。
 *
 * ⚠️ 关于 `def`：快照里的 `agentDefinition` 只存了 id/role/version/maxIterations
 * （见 `buildSnapshotJson`，为控制体积刻意裁剪），**缺 tools/mcpServers/systemPrompt/
 * sandboxPolicyId**。若直接拿快照里的 def 续跑，act/reason 会拿不到工具与提示词。
 * 因此 caller 必须从 DB 重新加载**完整** def 传进来（参考 GraphRunner
 * .fastResolveDefinitionFromDb）。本函数保持纯函数：不查 DB，便于单测。
 *
 * `inboundMessage` 优先用快照里持久化的那一份（buildSnapshotJson 存了完整 envelope）；
 * 调用方也可显式覆盖（HITL resume 时注入 hitlApproval 走的是重放路径，不经过这里）。
 *
 * events 在快照中有损（只保留 eventsTail 最后 50 条），但 events 不参与 ReAct 决策
 * （决策只看 iteration/observations/finalResponse/toolCalls，均为全量），resume 后
 * SSE 是新连接、历史帧本就不重放，故有损可接受。
 */
export function restoreStateFromSnapshot(
  loaded: LoadedSnapshot,
  def: RuntimeAgentDefinition,
  inboundMessageOverride?: A2AMessageEnvelope
): RestoredReactState {
  const snap = loaded.snapshot;
  const inboundMessage = (inboundMessageOverride ??
    (snap.inboundMessage as A2AMessageEnvelope)) as A2AMessageEnvelope;

  // 用 createInitialGraphState 建骨架（保证字段齐全 + 默认值），再覆盖运行态。
  const base = createInitialGraphState({
    runId: loaded.runId,
    workflowId: loaded.workflowRunId,
    traceId: (snap.traceId as string) ?? inboundMessage.traceId,
    agentDefinition: def,
    inboundMessage,
  });

  const eventsTail = Array.isArray(snap.eventsTail)
    ? (snap.eventsTail as AgentGraphState["events"])
    : [];

  const state: AgentGraphState = {
    ...base,
    iteration: typeof snap.iteration === "number" ? snap.iteration : loaded.iteration,
    contextMemory: (snap.contextMemory as Record<string, unknown>) ?? {},
    plannedAction: (snap.plannedAction as string | null) ?? null,
    reasonText: (snap.reasonText as string | null) ?? null,
    toolCalls: (snap.toolCalls as AgentGraphState["toolCalls"]) ?? [],
    observations: (snap.observations as AgentGraphState["observations"]) ?? [],
    finalResponse: (snap.finalResponse as Record<string, unknown> | null) ?? null,
    events: eventsTail,
    ...(typeof snap.artifactGapRetryCount === "number"
      ? { artifactGapRetryCount: snap.artifactGapRetryCount }
      : {}),
  };

  return {
    state,
    resumeIteration: state.iteration,
    resumePhase: loaded.phase,
  };
}
