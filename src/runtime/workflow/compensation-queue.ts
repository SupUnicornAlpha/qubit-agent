import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowCompensationTask, workflowRun } from "../../db/sqlite/schema";
import { dispatchTaskToRole } from "../agent-pool";

export async function enqueueCompensationTask(input: {
  workflowRunId: string;
  actionType?: "retry_from_start" | "resume" | "manual_intervention";
  reason?: string;
  payloadJson?: Record<string, unknown>;
  maxRetries?: number;
  nextRunAt?: string;
}) {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(workflowCompensationTask).values({
    id,
    workflowRunId: input.workflowRunId,
    actionType: input.actionType ?? "retry_from_start",
    reason: input.reason ?? "",
    payloadJson: input.payloadJson ?? {},
    maxRetries: input.maxRetries ?? 3,
    nextRunAt: input.nextRunAt ?? new Date().toISOString(),
    status: "pending",
  });
  const rows = await db.select().from(workflowCompensationTask).where(eq(workflowCompensationTask.id, id)).limit(1);
  return rows[0];
}

export async function listCompensationTasks(input?: { status?: string; workflowRunId?: string; limit?: number }) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowCompensationTask)
    .orderBy(desc(workflowCompensationTask.createdAt))
    .limit(input?.limit ?? 100);
  return rows.filter((row) => {
    if (input?.status && row.status !== input.status) return false;
    if (input?.workflowRunId && row.workflowRunId !== input.workflowRunId) return false;
    return true;
  });
}

export async function processCompensationQueue(limit = 10) {
  const db = await getDb();
  const now = new Date().toISOString();
  const candidates = await db
    .select()
    .from(workflowCompensationTask)
    .where(and(eq(workflowCompensationTask.status, "pending"), lte(workflowCompensationTask.nextRunAt, now)))
    .orderBy(asc(workflowCompensationTask.nextRunAt))
    .limit(limit);
  let picked = 0;
  let success = 0;
  let failed = 0;
  for (const task of candidates) {
    picked += 1;
    try {
      await db
        .update(workflowCompensationTask)
        .set({ status: "running", updatedAt: new Date().toISOString() })
        .where(eq(workflowCompensationTask.id, task.id));
      const workflowRows = await db.select().from(workflowRun).where(eq(workflowRun.id, task.workflowRunId)).limit(1);
      const workflow = workflowRows[0];
      if (!workflow) throw new Error("workflow not found");
      await db
        .update(workflowRun)
        .set({ status: "pending", endedAt: null })
        .where(eq(workflowRun.id, workflow.id));
      await dispatchTaskToRole({
        workflowId: workflow.id,
        role: "orchestrator",
        payload: {
          taskId: randomUUID(),
          taskType: task.actionType === "resume" ? "workflow_resume" : "workflow_retry",
          params: { workflowRunId: workflow.id, goal: workflow.goal, mode: workflow.mode, compensationTaskId: task.id },
          assignedRole: "orchestrator",
        },
      });
      await db
        .update(workflowCompensationTask)
        .set({ status: "completed", updatedAt: new Date().toISOString() })
        .where(eq(workflowCompensationTask.id, task.id));
      success += 1;
    } catch (error) {
      const retryCount = task.retryCount + 1;
      const exhausted = retryCount >= task.maxRetries;
      await db
        .update(workflowCompensationTask)
        .set({
          status: exhausted ? "failed" : "pending",
          retryCount,
          lastError: error instanceof Error ? error.message : "unknown error",
          nextRunAt: exhausted ? task.nextRunAt : new Date(Date.now() + retryCount * 60_000).toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(workflowCompensationTask.id, task.id));
      failed += 1;
    }
  }
  return { picked, success, failed };
}
