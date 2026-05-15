import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  brokerAccount,
  brokerOrder,
  executionTask,
  executionTaskEvent,
  fill,
} from "../../db/sqlite/schema";
import { connectorForAccount, resolveBrokerAccount } from "../reia/broker-service";
import type { BrokerProvider } from "../reia/broker-types";

/** Poll broker for orders in waiting_ack / partially_filled (Phase 3). */
export async function pollPendingBrokerOrders(db: DbClient, nowIso: string): Promise<void> {
  const tasks = await db
    .select()
    .from(executionTask)
    .where(
      and(
        eq(executionTask.status, "waiting_ack"),
        eq(executionTask.dispatchMode, "live")
      )
    )
    .limit(20);

  for (const task of tasks) {
    if (!task.brokerAccountId) continue;

    const orders = await db
      .select()
      .from(brokerOrder)
      .where(eq(brokerOrder.orderIntentId, task.orderIntentId))
      .limit(1);
    const bo = orders[0];
    if (!bo || bo.status === "filled" || bo.status === "cancelled" || bo.status === "rejected") {
      continue;
    }

    try {
      const brokerRows = await db
        .select()
        .from(brokerAccount)
        .where(eq(brokerAccount.id, task.brokerAccountId))
        .limit(1);
      const accountRow = brokerRows[0];
      if (!accountRow) continue;

      const provider = accountRow.provider as BrokerProvider;
      const resolved = await resolveBrokerAccount(provider, accountRow.accountRef);
      if (!resolved) continue;

      const connector = connectorForAccount(resolved);
      const live = await connector.getOrder(bo.brokerOrderId);

      if (live.status === "filled") {
        const fillId = randomUUID();
        await db.insert(fill).values({
          id: fillId,
          brokerOrderId: bo.id,
          fillQty: live.actualQuantity,
          fillPrice: live.actualPrice,
          fee: 0,
        });
        await db
          .update(brokerOrder)
          .set({ status: "filled", updatedAt: nowIso })
          .where(eq(brokerOrder.id, bo.id));
        await db.insert(executionTaskEvent).values({
          id: randomUUID(),
          executionTaskId: task.id,
          eventType: "fill",
          eventPayloadJson: { brokerOrderId: bo.id, fillId, polled: true },
          eventAt: nowIso,
        });
        await db
          .update(executionTask)
          .set({ status: "filled", updatedAt: nowIso, lastError: null })
          .where(eq(executionTask.id, task.id));
      } else if (live.status === "rejected" || live.status === "cancelled") {
        await db
          .update(brokerOrder)
          .set({
            status: live.status === "rejected" ? "rejected" : "cancelled",
            updatedAt: nowIso,
          })
          .where(eq(brokerOrder.id, bo.id));
        await db
          .update(executionTask)
          .set({
            status: live.status === "rejected" ? "failed" : "cancelled",
            lastError: live.status,
            updatedAt: nowIso,
          })
          .where(eq(executionTask.id, task.id));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(executionTask)
        .set({ lastError: msg, updatedAt: nowIso })
        .where(eq(executionTask.id, task.id));
    }
  }
}
