import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { getDb, runInTransaction } from "../../db/sqlite/client";
import { a2aTask, a2aTaskEvent } from "../../db/sqlite/schema";
import {
  type A2ATaskEventType,
  type A2ATaskState,
  type TaskAssignPayload,
  type TaskProgressPayload,
  type TaskResultPayload,
  isA2ATaskTerminal,
} from "../../types/a2a";
import type { AgentRole } from "../../types/entities";

export type A2ATaskSnapshot = {
  id: string;
  workflowRunId: string;
  contextId: string;
  parentTaskId: string | null;
  traceId: string;
  senderAgentId: string;
  receiverAgentId: string;
  receiverRole: string;
  status: A2ATaskState;
  revision: number;
  input: unknown;
  result: unknown;
  error: unknown;
  deadlineAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type A2ATaskWaitResult = {
  task: A2ATaskSnapshot | null;
  timedOut: boolean;
  timeoutReason?: "wall_clock" | "lease_expired";
};

export type A2ATaskEventSnapshot = {
  id: string;
  taskId: string;
  sequence: number;
  eventType: A2ATaskEventType;
  payload: unknown;
  createdAt: string;
};

function asSnapshot(row: typeof a2aTask.$inferSelect): A2ATaskSnapshot {
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    contextId: row.contextId,
    parentTaskId: row.parentTaskId,
    traceId: row.traceId,
    senderAgentId: row.senderAgentId,
    receiverAgentId: row.receiverAgentId,
    receiverRole: row.receiverRole,
    status: row.status as A2ATaskState,
    revision: row.revision,
    input: row.inputJson,
    result: row.resultJson,
    error: row.errorJson,
    deadlineAt: row.deadlineAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parentTaskId(payload: TaskAssignPayload): string | null {
  const value = (payload.params as Record<string, unknown>).parentTaskId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function getTaskRow(taskId: string): Promise<typeof a2aTask.$inferSelect | null> {
  const db = await getDb();
  const rows = await db.select().from(a2aTask).where(eq(a2aTask.id, taskId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Creates the durable Task before local delivery.  Repeating the same task id
 * is idempotent; a caller may safely retry after a process interruption.
 */
export async function createA2ATask(input: {
  workflowId: string;
  traceId: string;
  senderAgentId: string;
  receiverAgentId: string;
  receiverRole: AgentRole;
  payload: TaskAssignPayload;
}): Promise<A2ATaskSnapshot> {
  const existing = await getTaskRow(input.payload.taskId);
  if (existing) {
    if (existing.workflowRunId !== input.workflowId) {
      throw new Error(`a2a_task_id_conflict:${input.payload.taskId}`);
    }
    return asSnapshot(existing);
  }

  const db = await getDb();
  const now = new Date().toISOString();
  await runInTransaction(db, async () => {
    await db.insert(a2aTask).values({
      id: input.payload.taskId,
      workflowRunId: input.workflowId,
      contextId: input.workflowId,
      parentTaskId: parentTaskId(input.payload),
      traceId: input.traceId,
      senderAgentId: input.senderAgentId,
      receiverAgentId: input.receiverAgentId,
      receiverRole: input.receiverRole,
      status: "submitted",
      revision: 0,
      idempotencyKey: input.payload.taskId,
      inputJson: input.payload,
      deadlineAt: input.payload.deadline ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(a2aTaskEvent).values({
      id: randomUUID(),
      taskId: input.payload.taskId,
      sequence: 0,
      eventType: "submitted",
      payloadJson: {
        taskId: input.payload.taskId,
        contextId: input.workflowId,
        senderAgentId: input.senderAgentId,
        receiverAgentId: input.receiverAgentId,
        receiverRole: input.receiverRole,
        deadlineAt: input.payload.deadline ?? null,
      },
      createdAt: now,
    });
  });
  const created = await getTaskRow(input.payload.taskId);
  if (!created) throw new Error(`a2a_task_create_failed:${input.payload.taskId}`);
  return asSnapshot(created);
}

async function appendA2ATaskEvent(input: {
  taskId: string;
  eventType: A2ATaskEventType;
  status?: A2ATaskState;
  payload: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  terminal?: boolean;
}): Promise<A2ATaskSnapshot | null> {
  const db = await getDb();
  let snapshot: A2ATaskSnapshot | null = null;
  await runInTransaction(db, async () => {
    const rows = await db.select().from(a2aTask).where(eq(a2aTask.id, input.taskId)).limit(1);
    const task = rows[0];
    if (!task) return;
    const currentStatus = task.status as A2ATaskState;
    if (isA2ATaskTerminal(currentStatus)) {
      snapshot = asSnapshot(task);
      return;
    }

    const now = new Date().toISOString();
    const nextStatus = input.status ?? currentStatus;
    const revision = task.revision + 1;
    const startedAt = task.startedAt ?? (nextStatus === "working" ? now : null);
    const completedAt = input.terminal ? now : task.completedAt;
    await db
      .update(a2aTask)
      .set({
        status: nextStatus,
        revision,
        startedAt,
        completedAt,
        ...(input.result !== undefined ? { resultJson: input.result } : {}),
        ...(input.error !== undefined ? { errorJson: input.error } : {}),
        updatedAt: now,
      })
      .where(eq(a2aTask.id, task.id));
    await db.insert(a2aTaskEvent).values({
      id: randomUUID(),
      taskId: task.id,
      sequence: revision,
      eventType: input.eventType,
      payloadJson: input.payload,
      createdAt: now,
    });
    snapshot = {
      ...asSnapshot(task),
      status: nextStatus,
      revision,
      result: input.result !== undefined ? input.result : task.resultJson,
      error: input.error !== undefined ? input.error : task.errorJson,
      startedAt,
      completedAt,
      updatedAt: now,
    };
  });
  return snapshot;
}

export async function markA2ATaskWorking(taskId: string): Promise<A2ATaskSnapshot | null> {
  return appendA2ATaskEvent({
    taskId,
    eventType: "working",
    status: "working",
    payload: { taskId, state: "working" },
  });
}

export async function recordA2ATaskProgress(
  taskId: string,
  progress: TaskProgressPayload
): Promise<A2ATaskSnapshot | null> {
  return appendA2ATaskEvent({
    taskId,
    eventType: "progress",
    status: "working",
    payload: { ...progress, taskId },
  });
}

export async function completeA2ATask(
  taskId: string,
  result: TaskResultPayload
): Promise<A2ATaskSnapshot | null> {
  const status: A2ATaskState =
    result.status === "completed" || result.success
      ? "completed"
      : result.status === "cancelled"
        ? "cancelled"
        : result.status === "awaiting_approval"
          ? "input_required"
          : "failed";
  return appendA2ATaskEvent({
    taskId,
    eventType:
      status === "completed"
        ? "completed"
        : status === "cancelled"
          ? "cancelled"
          : status === "input_required"
            ? "input_required"
            : "failed",
    status,
    payload: {
      taskId,
      status,
      success: result.success,
      summary: result.summary ?? null,
      durationMs: result.durationMs,
    },
    result: result.result,
    ...(status === "completed" || status === "input_required"
      ? {}
      : {
          error: {
            code: result.errorCode ?? "a2a_task_failed",
            message: result.errorMessage ?? "A2A task failed",
          },
        }),
    terminal: status !== "input_required",
  });
}

export async function cancelA2ATask(taskId: string, reason = "cancelled_by_parent"): Promise<void> {
  await appendA2ATaskEvent({
    taskId,
    eventType: "cancelled",
    status: "cancelled",
    payload: { taskId, reason },
    error: { code: "cancelled", message: reason },
    terminal: true,
  });
}

export async function getA2ATask(taskId: string): Promise<A2ATaskSnapshot | null> {
  const row = await getTaskRow(taskId);
  return row ? asSnapshot(row) : null;
}

/** Read model for reconnecting clients and workflow recovery. */
export async function listA2ATasksForWorkflow(
  workflowId: string,
  limit = 200
): Promise<A2ATaskSnapshot[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(a2aTask)
    .where(eq(a2aTask.workflowRunId, workflowId))
    .orderBy(desc(a2aTask.createdAt))
    .limit(Math.max(1, Math.min(500, limit)));
  return rows.map(asSnapshot);
}

/**
 * Events are append-only and sequence-numbered, allowing a client to resume
 * from its last observed sequence instead of relying on a live process stream.
 */
export async function listA2ATaskEvents(
  taskId: string,
  afterSequence?: number,
  limit = 200
): Promise<A2ATaskEventSnapshot[]> {
  const db = await getDb();
  const hasAfterSequence = typeof afterSequence === "number" && Number.isFinite(afterSequence);
  const rows = await db
    .select()
    .from(a2aTaskEvent)
    .where(
      and(
        eq(a2aTaskEvent.taskId, taskId),
        hasAfterSequence ? gt(a2aTaskEvent.sequence, afterSequence) : undefined
      )
    )
    .orderBy(asc(a2aTaskEvent.sequence))
    .limit(Math.max(1, Math.min(500, limit)));
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    sequence: row.sequence,
    eventType: row.eventType as A2ATaskEventType,
    payload: row.payloadJson,
    createdAt: row.createdAt,
  }));
}

/** Durable replacement for a process-local gather waiter; safe after restart. */
export async function waitForA2ATaskTerminal(
  taskId: string,
  opts: { timeoutMs: number; leaseMs: number; pollMs?: number }
): Promise<A2ATaskWaitResult> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, opts.timeoutMs);
  const leaseMs = Math.max(1, opts.leaseMs);
  const pollMs = Math.max(25, opts.pollMs ?? 100);
  while (true) {
    const task = await getA2ATask(taskId);
    if (!task) return { task: null, timedOut: false };
    // input_required is not terminal in A2A, but it is a settled response for
    // a parent waiting for this turn: it must surface HITL rather than timing
    // out and incorrectly cancel a task that is awaiting input.
    if (isA2ATaskTerminal(task.status) || task.status === "input_required") {
      return { task, timedOut: false };
    }
    const now = Date.now();
    if (now - startedAt >= timeoutMs) return { task, timedOut: true, timeoutReason: "wall_clock" };
    const lastProgressAt = Date.parse(task.updatedAt);
    if (Number.isFinite(lastProgressAt) && now - lastProgressAt >= leaseMs) {
      return { task, timedOut: true, timeoutReason: "lease_expired" };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}
