import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, lt } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import {
  executionTask,
  executionTaskEvent,
  orderIntent,
  riskReviewTicket,
} from "../../db/sqlite/schema";
import { dispatchExecutionTask } from "./execution-dispatcher";
import { pollPendingBrokerOrders } from "./execution-dispatcher-poll";
import { processConditionalOrders } from "./conditional-order-service";

const DEFAULT_TICK_MS = 1500;
const RETRY_DELAY_MS = 30_000;

async function appendEvent(
  db: DbClient,
  input: {
    executionTaskId: string;
    eventType: (typeof executionTaskEvent.$inferInsert)["eventType"];
    payload: Record<string, unknown>;
    eventAt?: string;
  }
): Promise<void> {
  const eventAt = input.eventAt ?? new Date().toISOString();
  await db.insert(executionTaskEvent).values({
    id: randomUUID(),
    executionTaskId: input.executionTaskId,
    eventType: input.eventType,
    eventPayloadJson: input.payload,
    eventAt,
  });
}

async function expireStaleRiskReviews(db: DbClient, nowIso: string): Promise<void> {
  const stale = await db
    .select()
    .from(riskReviewTicket)
    .where(and(eq(riskReviewTicket.status, "open"), lt(riskReviewTicket.expiresAt, nowIso)));

  for (const t of stale) {
    await db
      .update(riskReviewTicket)
      .set({ status: "expired", updatedAt: nowIso })
      .where(eq(riskReviewTicket.id, t.id));

    await db
      .update(executionTask)
      .set({
        status: "rejected",
        lastError: "risk_review_ticket_expired",
        updatedAt: nowIso,
      })
      .where(
        and(eq(executionTask.orderIntentId, t.orderIntentId), eq(executionTask.status, "awaiting_review"))
      );
    await db
      .update(orderIntent)
      .set({ lifecycleStatus: "rejected", lifecycleUpdatedAt: nowIso })
      .where(eq(orderIntent.id, t.orderIntentId));
  }
}

async function processOneTask(db: DbClient, taskId: string, nowIso: string): Promise<void> {
  const locked = await db
    .update(executionTask)
    .set({ status: "dispatching", updatedAt: nowIso })
    .where(and(eq(executionTask.id, taskId), eq(executionTask.status, "pending")))
    .returning();

  if (!locked.length) return;

  const task = locked[0];
  if (!task) return;
  await db
    .update(orderIntent)
    .set({ lifecycleStatus: "submitted", lifecycleUpdatedAt: nowIso })
    .where(eq(orderIntent.id, task.orderIntentId));

  try {
    await appendEvent(db, {
      executionTaskId: task.id,
      eventType: "dispatch",
      payload: { taskId: task.id, dispatchMode: task.dispatchMode },
    });

    const result = await dispatchExecutionTask(db, {
      executionTaskId: task.id,
      orderIntentId: task.orderIntentId,
      accountId: task.accountId,
      dispatchMode: task.dispatchMode ?? "paper",
      brokerAccountId: task.brokerAccountId,
    });

    if (result.status === "waiting_ack" || result.status === "partially_filled") {
      await db
        .update(orderIntent)
        .set({
          lifecycleStatus: result.status === "partially_filled" ? "partial" : "submitted",
          lifecycleUpdatedAt: nowIso,
        })
        .where(eq(orderIntent.id, task.orderIntentId));
      return;
    }

    await db
      .update(executionTask)
      .set({
        status: "filled",
        updatedAt: nowIso,
        lastError: null,
      })
      .where(eq(executionTask.id, task.id));
    await db
      .update(orderIntent)
      .set({ lifecycleStatus: "filled", lifecycleUpdatedAt: nowIso })
      .where(eq(orderIntent.id, task.orderIntentId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const retries = task.retryCount + 1;
    const shouldRetry = retries < task.maxRetries;
    await appendEvent(db, {
      executionTaskId: task.id,
      eventType: shouldRetry ? "retry" : "reject",
      payload: { error: msg, retryCount: retries },
    });

    if (shouldRetry) {
      const nextAt = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
      await db
        .update(executionTask)
        .set({
          status: "pending",
          retryCount: retries,
          nextRetryAt: nextAt,
          lastError: msg,
          updatedAt: nowIso,
        })
        .where(eq(executionTask.id, task.id));
      await db
        .update(orderIntent)
        .set({ lifecycleStatus: "risk_checked", lifecycleUpdatedAt: nowIso })
        .where(eq(orderIntent.id, task.orderIntentId));
    } else {
      await db
        .update(executionTask)
        .set({
          status: "failed",
          retryCount: retries,
          lastError: msg,
          updatedAt: nowIso,
        })
        .where(eq(executionTask.id, task.id));
      await db
        .update(orderIntent)
        .set({ lifecycleStatus: "rejected", lifecycleUpdatedAt: nowIso })
        .where(eq(orderIntent.id, task.orderIntentId));
    }
  }
}

export async function processExecutionTasks(db: DbClient, now = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  await expireStaleRiskReviews(db, nowIso);
  await pollPendingBrokerOrders(db, nowIso);
  await processConditionalOrders(db, nowIso);

  const due = await db
    .select()
    .from(executionTask)
    .where(
      and(
        eq(executionTask.status, "pending"),
        or(isNull(executionTask.nextRetryAt), lte(executionTask.nextRetryAt, nowIso))
      )
    )
    .orderBy(asc(executionTask.createdAt))
    .limit(10);

  for (const row of due) {
    await processOneTask(db, row.id, nowIso);
  }
  await processConditionalOrders(db, nowIso);
}

export class ExecutionWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const db = await getDb();
      await processExecutionTasks(db, now);
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, DEFAULT_TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export const executionWorker = new ExecutionWorker();
