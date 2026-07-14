import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  brokerAccount,
  brokerOrder,
  executionTask,
  executionTaskEvent,
  orderIntent,
} from "../../db/sqlite/schema";
import type { BrokerProviderConfig } from "../../types/broker";
import { appendAuditLog } from "../audit/audit-chain-service";
import { connectorForAccount } from "./broker/broker-service";
import { resolveExecutionMark } from "./execution-mark-service";

export interface ConditionalTriggerInput {
  orderType: "stop" | "stop_limit" | "trailing_stop";
  side: "buy" | "sell";
  markPrice: number;
  stopPrice?: number | null;
  trailingOffsetPct?: number | null;
  trailingAnchorPrice?: number | null;
  triggerDirection?: "above" | "below" | null;
}

export interface ConditionalTriggerResult {
  triggered: boolean;
  triggerPrice: number;
  nextAnchorPrice: number | null;
}

export async function amendWaitingConditionalOrder(
  db: DbClient,
  input: {
    orderIntentId: string;
    expectedLifecycleUpdatedAt: string;
    stopPrice?: number;
    trailingOffsetPct?: number;
    triggerDirection?: "above" | "below";
    resetTrailingAnchorPrice?: number;
    actorId?: string;
  },
) {
  const intent = (await db.select().from(orderIntent)
    .where(eq(orderIntent.id, input.orderIntentId)).limit(1))[0];
  if (!intent) throw new Error("order_intent_not_found");
  if (intent.lifecycleUpdatedAt !== input.expectedLifecycleUpdatedAt) {
    throw new Error("conditional_order_amend_stale");
  }
  if (intent.orderType !== "stop" && intent.orderType !== "stop_limit" && intent.orderType !== "trailing_stop") {
    throw new Error("order_intent_is_not_conditional");
  }
  const task = (await db.select().from(executionTask)
    .where(eq(executionTask.orderIntentId, intent.id)).limit(1))[0];
  if (!task || !["held", "conditional_wait", "awaiting_review"].includes(task.status)) {
    throw new Error("conditional_order_already_submitted");
  }
  if (input.stopPrice !== undefined && (!Number.isFinite(input.stopPrice) || input.stopPrice <= 0)) {
    throw new Error("conditional_order_requires_positive_stop_price");
  }
  if (
    input.trailingOffsetPct !== undefined &&
    (!Number.isFinite(input.trailingOffsetPct) || input.trailingOffsetPct <= 0 || input.trailingOffsetPct >= 1)
  ) throw new Error("trailing_stop_requires_offset_between_zero_and_one");
  if (
    input.resetTrailingAnchorPrice !== undefined &&
    (!Number.isFinite(input.resetTrailingAnchorPrice) || input.resetTrailingAnchorPrice <= 0)
  ) throw new Error("trailing_anchor_must_be_positive");
  const patch = {
    ...(input.stopPrice !== undefined ? { stopPrice: input.stopPrice } : {}),
    ...(input.trailingOffsetPct !== undefined ? { trailingOffsetPct: input.trailingOffsetPct } : {}),
    ...(input.triggerDirection !== undefined ? { triggerDirection: input.triggerDirection } : {}),
    ...(input.resetTrailingAnchorPrice !== undefined
      ? { trailingAnchorPrice: input.resetTrailingAnchorPrice }
      : {}),
    lifecycleUpdatedAt: new Date().toISOString(),
  };
  const updated = await db.update(orderIntent).set(patch).where(and(
    eq(orderIntent.id, intent.id),
    eq(orderIntent.lifecycleUpdatedAt, input.expectedLifecycleUpdatedAt),
  )).returning();
  if (!updated[0]) throw new Error("conditional_order_amend_stale");
  await appendAuditLog(db, {
    traceId: task.traceId || `amend:${intent.id}`,
    workflowRunId: intent.workflowRunId,
    actorType: "user",
    actorId: input.actorId?.trim() || "user",
    action: "conditional_order_amended",
    resourceType: "order_intent",
    resourceId: intent.id,
    detailJson: patch,
  });
  return updated[0];
}

export function evaluateConditionalTrigger(input: ConditionalTriggerInput): ConditionalTriggerResult {
  if (!Number.isFinite(input.markPrice) || input.markPrice <= 0) {
    throw new Error("conditional_mark_price_invalid");
  }
  if (input.orderType === "trailing_stop") {
    const offset = input.trailingOffsetPct ?? 0;
    if (!(offset > 0 && offset < 1)) throw new Error("trailing_offset_invalid");
    const priorAnchor = input.trailingAnchorPrice ?? input.markPrice;
    const nextAnchorPrice = input.side === "sell"
      ? Math.max(priorAnchor, input.markPrice)
      : Math.min(priorAnchor, input.markPrice);
    const triggerPrice = input.side === "sell"
      ? nextAnchorPrice * (1 - offset)
      : nextAnchorPrice * (1 + offset);
    return {
      triggered: input.side === "sell" ? input.markPrice <= triggerPrice : input.markPrice >= triggerPrice,
      triggerPrice,
      nextAnchorPrice,
    };
  }
  const triggerPrice = input.stopPrice ?? 0;
  if (!(triggerPrice > 0)) throw new Error("conditional_stop_price_invalid");
  const triggered = input.triggerDirection === "above"
    ? input.markPrice >= triggerPrice
    : input.triggerDirection === "below"
      ? input.markPrice <= triggerPrice
      : input.side === "sell"
        ? input.markPrice <= triggerPrice
        : input.markPrice >= triggerPrice;
  return {
    triggered,
    triggerPrice,
    nextAnchorPrice: null,
  };
}

async function appendConditionalEvent(
  db: DbClient,
  taskId: string,
  eventType: "trigger" | "activate" | "cancel",
  payload: Record<string, unknown>,
  eventAt: string,
): Promise<void> {
  await db.insert(executionTaskEvent).values({
    id: randomUUID(),
    executionTaskId: taskId,
    eventType,
    eventPayloadJson: payload,
    eventAt,
  });
}

export async function processConditionalOrders(db: DbClient, nowIso: string): Promise<void> {
  const heldTasks = await db.select().from(executionTask).where(eq(executionTask.status, "held")).limit(50);
  for (const task of heldTasks) {
    const child = (await db.select().from(orderIntent).where(eq(orderIntent.id, task.orderIntentId)).limit(1))[0];
    if (!child?.parentOrderIntentId) continue;
    const parent = (await db.select().from(orderIntent).where(eq(orderIntent.id, child.parentOrderIntentId)).limit(1))[0];
    if (!parent) continue;
    if (parent.lifecycleStatus === "filled") {
      const conditional = child.orderType === "stop" || child.orderType === "stop_limit" || child.orderType === "trailing_stop";
      await db.update(orderIntent).set({
        activationStatus: conditional ? "waiting_trigger" : "active",
        lifecycleUpdatedAt: nowIso,
      }).where(eq(orderIntent.id, child.id));
      await db.update(executionTask).set({
        status: conditional ? "conditional_wait" : "pending",
        updatedAt: nowIso,
      }).where(eq(executionTask.id, task.id));
      await appendConditionalEvent(db, task.id, "activate", { parentOrderIntentId: parent.id }, nowIso);
    } else if (parent.lifecycleStatus === "cancelled" || parent.lifecycleStatus === "rejected") {
      await db.update(orderIntent).set({ lifecycleStatus: "cancelled", lifecycleUpdatedAt: nowIso })
        .where(eq(orderIntent.id, child.id));
      await db.update(executionTask).set({ status: "cancelled", lastError: "parent_not_filled", updatedAt: nowIso })
        .where(eq(executionTask.id, task.id));
      await appendConditionalEvent(db, task.id, "cancel", { parentOrderIntentId: parent.id }, nowIso);
    }
  }

  const waiting = await db.select().from(executionTask).where(eq(executionTask.status, "conditional_wait")).limit(50);
  for (const task of waiting) {
    const intent = (await db.select().from(orderIntent).where(eq(orderIntent.id, task.orderIntentId)).limit(1))[0];
    if (!intent || (intent.orderType !== "stop" && intent.orderType !== "stop_limit" && intent.orderType !== "trailing_stop")) continue;
    const mark = await resolveExecutionMark(db, {
      market: intent.market,
      symbol: intent.symbol ?? "",
      nowIso,
    });
    if (!mark) continue;
    const result = evaluateConditionalTrigger({
      orderType: intent.orderType,
      side: intent.side,
      markPrice: mark.price,
      stopPrice: intent.stopPrice,
      trailingOffsetPct: intent.trailingOffsetPct,
      trailingAnchorPrice: intent.trailingAnchorPrice,
      triggerDirection: intent.triggerDirection,
    });
    if (intent.orderType === "trailing_stop" && result.nextAnchorPrice !== intent.trailingAnchorPrice) {
      await db.update(orderIntent).set({ trailingAnchorPrice: result.nextAnchorPrice, lifecycleUpdatedAt: nowIso })
        .where(eq(orderIntent.id, intent.id));
    }
    if (!result.triggered) continue;
    await db.update(orderIntent).set({
      activationStatus: "triggered",
      price: intent.orderType === "stop_limit" ? intent.price : mark.price,
      lifecycleUpdatedAt: nowIso,
    }).where(eq(orderIntent.id, intent.id));
    await db.update(executionTask).set({ status: "pending", nextRetryAt: null, updatedAt: nowIso })
      .where(and(eq(executionTask.id, task.id), eq(executionTask.status, "conditional_wait")));
    await appendConditionalEvent(db, task.id, "trigger", {
      markPrice: mark.price,
      triggerPrice: result.triggerPrice,
      source: mark.source,
      observedAt: mark.observedAt,
      freshness: mark.freshness,
    }, nowIso);
  }

  const filledOco = await db.select().from(orderIntent).where(and(
    eq(orderIntent.lifecycleStatus, "filled"),
    inArray(orderIntent.activationStatus, ["active", "triggered"]),
  ));
  for (const winner of filledOco) {
    if (!winner.ocoGroupId) continue;
    const siblings = await db.select().from(orderIntent).where(eq(orderIntent.ocoGroupId, winner.ocoGroupId));
    for (const sibling of siblings) {
      if (
        sibling.id === winner.id ||
        !["created", "risk_checked", "submitted", "partial"].includes(sibling.lifecycleStatus)
      ) continue;
      const tasks = await db.select().from(executionTask).where(eq(executionTask.orderIntentId, sibling.id)).limit(1);
      const task = tasks[0];
      if (!task || ![
        "held", "conditional_wait", "pending", "awaiting_review", "waiting_ack", "partially_filled",
      ].includes(task.status)) continue;
      if ((task.status === "waiting_ack" || task.status === "partially_filled") && task.brokerAccountId) {
        const account = (await db.select().from(brokerAccount)
          .where(eq(brokerAccount.id, task.brokerAccountId)).limit(1))[0];
        const submittedOrder = (await db.select().from(brokerOrder)
          .where(eq(brokerOrder.orderIntentId, sibling.id)).limit(1))[0];
        if (!account || !submittedOrder?.brokerOrderId) continue;
        try {
          const connector = connectorForAccount({
            id: account.id,
            provider: account.provider,
            accountRef: account.accountRef,
            mode: account.mode,
            baseUrl: account.baseUrl,
            providerConfigJson: (account.providerConfigJson ?? {}) as BrokerProviderConfig,
            isDefault: account.isDefault,
            enabled: account.enabled,
          });
          await connector.cancelOrder(submittedOrder.brokerOrderId);
          await db.update(brokerOrder).set({ status: "cancelled", updatedAt: nowIso })
            .where(eq(brokerOrder.id, submittedOrder.id));
        } catch (error) {
          await db.update(executionTask).set({
            lastError: `oco_cancel_failed:${error instanceof Error ? error.message : String(error)}`,
            updatedAt: nowIso,
          }).where(eq(executionTask.id, task.id));
          continue;
        }
      }
      await db.update(orderIntent).set({ lifecycleStatus: "cancelled", lifecycleUpdatedAt: nowIso })
        .where(eq(orderIntent.id, sibling.id));
      await db.update(executionTask).set({ status: "cancelled", lastError: `oco_filled:${winner.id}`, updatedAt: nowIso })
        .where(eq(executionTask.id, task.id));
      await appendConditionalEvent(db, task.id, "cancel", { ocoGroupId: winner.ocoGroupId, winnerOrderIntentId: winner.id }, nowIso);
      await appendAuditLog(db, {
        traceId: task.traceId || `oco:${winner.ocoGroupId}`,
        workflowRunId: sibling.workflowRunId,
        actorType: "system",
        actorId: "conditional_order_service",
        action: "oco_sibling_cancelled",
        resourceType: "order_intent",
        resourceId: sibling.id,
        detailJson: { ocoGroupId: winner.ocoGroupId, winnerOrderIntentId: winner.id },
      });
    }
  }
}
