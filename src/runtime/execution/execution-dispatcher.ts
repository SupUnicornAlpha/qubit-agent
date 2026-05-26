import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  BUILTIN_PAPER_CONNECTOR_INSTANCE_ID,
  BUILTIN_PAPER_TRADING_ACCOUNT_ID,
  brokerAccount,
  brokerOrder,
  executionTask,
  executionTaskEvent,
  fill,
  orderIntent,
} from "../../db/sqlite/schema";
import { executeWithPolicy } from "../external-call/policy";
import { connectorForAccount, resolveBrokerAccount } from "../reia/broker-service";
import type { BrokerProvider } from "../../types/broker";
import { isLiveTradingEnabled } from "./live-trading-gate";

export type DispatchMode = "paper" | "live";

export interface DispatchExecutionInput {
  executionTaskId: string;
  orderIntentId: string;
  accountId: string;
  dispatchMode: DispatchMode;
  brokerAccountId?: string | null;
}

export interface DispatchExecutionResult {
  brokerOrderPk: string;
  externalOrderId: string;
  fillPrice: number;
  fillQty: number;
  status: "filled" | "waiting_ack" | "partially_filled";
}

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

async function dispatchBuiltinPaper(
  db: DbClient,
  input: DispatchExecutionInput,
  intent: typeof orderIntent.$inferSelect,
  fillPrice: number,
  nowIso: string
): Promise<DispatchExecutionResult> {
  const brokerOrderPk = randomUUID();
  const externalOrderId = `paper-${brokerOrderPk.slice(0, 8)}`;

  await appendEvent(db, {
    executionTaskId: input.executionTaskId,
    eventType: "ack",
    payload: { brokerOrderId: externalOrderId, mode: "paper" },
  });

  await db.insert(brokerOrder).values({
    id: brokerOrderPk,
    orderIntentId: intent.id,
    accountId: input.accountId || BUILTIN_PAPER_TRADING_ACCOUNT_ID,
    connectorInstanceId: BUILTIN_PAPER_CONNECTOR_INSTANCE_ID,
    brokerOrderId: externalOrderId,
    status: "submitted",
  });

  await db
    .update(brokerOrder)
    .set({ status: "filled", updatedAt: nowIso })
    .where(eq(brokerOrder.id, brokerOrderPk));

  const fillId = randomUUID();
  await db.insert(fill).values({
    id: fillId,
    brokerOrderId: brokerOrderPk,
    fillQty: intent.qty,
    fillPrice,
    fee: 0,
  });

  await appendEvent(db, {
    executionTaskId: input.executionTaskId,
    eventType: "fill",
    payload: { brokerOrderId: brokerOrderPk, fillId, qty: intent.qty, price: fillPrice },
  });

  return {
    brokerOrderPk,
    externalOrderId,
    fillPrice,
    fillQty: intent.qty,
    status: "filled",
  };
}

async function dispatchLiveBroker(
  db: DbClient,
  input: DispatchExecutionInput,
  intent: typeof orderIntent.$inferSelect,
  fillPrice: number,
  nowIso: string
): Promise<DispatchExecutionResult> {
  if (!isLiveTradingEnabled()) {
    throw new Error("live_trading_disabled");
  }

  if (!input.brokerAccountId) {
    throw new Error("broker_account_id_required_for_live");
  }

  const accounts = await db
    .select()
    .from(brokerAccount)
    .where(eq(brokerAccount.id, input.brokerAccountId))
    .limit(1);
  const accountRow = accounts[0];
  if (!accountRow || !accountRow.enabled) {
    throw new Error("broker_account_not_found_or_disabled");
  }

  const provider = accountRow.provider as BrokerProvider;
  const resolved = await resolveBrokerAccount(provider, accountRow.accountRef);
  if (!resolved) throw new Error("broker_account_resolve_failed");

  const connector = connectorForAccount(resolved);
  const ticker =
    intent.symbol?.trim() ||
    (await db.select().from(orderIntent).where(eq(orderIntent.id, intent.id)).limit(1))[0]?.symbol ||
    intent.instrumentId;

  const side = intent.side;
  const orderType = intent.orderType === "market" ? "market" : "limit";
  const limitPrice = orderType === "limit" ? (intent.price ?? fillPrice) : undefined;

  await appendEvent(db, {
    executionTaskId: input.executionTaskId,
    eventType: "dispatch",
    payload: { provider, ticker, mode: "live" },
  });

  const live = await executeWithPolicy(
    {
      scopeKey: `broker:${provider}:${ticker}`,
      retry: { maxAttempts: 2, backoffMs: 200, backoffMultiplier: 2 },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 30_000 },
      idempotency: {
        enabled: true,
        key: `broker:${provider}:intent:${intent.id}`,
        ttlMs: 15_000,
      },
    },
    async () =>
      connector.submitOrder({
        ticker,
        side,
        quantity: intent.qty,
        orderType,
        limitPrice,
      })
  );

  const brokerOrderPk = randomUUID();
  const externalOrderId = live.brokerOrderId;

  await appendEvent(db, {
    executionTaskId: input.executionTaskId,
    eventType: "ack",
    payload: { brokerOrderId: externalOrderId, provider },
  });

  const brokerStatus =
    live.status === "filled"
      ? "filled"
      : live.status === "rejected"
        ? "rejected"
        : "submitted";

  await db.insert(brokerOrder).values({
    id: brokerOrderPk,
    orderIntentId: intent.id,
    accountId: input.accountId,
    connectorInstanceId: `broker:${provider}:${resolved.accountRef}`,
    brokerOrderId: externalOrderId,
    status: brokerStatus === "filled" ? "filled" : "submitted",
  });

  if (live.status === "filled") {
    const fillId = randomUUID();
    await db.insert(fill).values({
      id: fillId,
      brokerOrderId: brokerOrderPk,
      fillQty: live.actualQuantity,
      fillPrice: live.actualPrice,
      fee: 0,
    });
    await appendEvent(db, {
      executionTaskId: input.executionTaskId,
      eventType: "fill",
      payload: {
        brokerOrderId: brokerOrderPk,
        fillId,
        qty: live.actualQuantity,
        price: live.actualPrice,
      },
    });
    await db
      .update(brokerOrder)
      .set({ status: "filled", updatedAt: nowIso })
      .where(eq(brokerOrder.id, brokerOrderPk));

    return {
      brokerOrderPk,
      externalOrderId,
      fillPrice: live.actualPrice,
      fillQty: live.actualQuantity,
      status: "filled",
    };
  }

  if (live.status === "rejected") {
    await db
      .update(brokerOrder)
      .set({ status: "rejected", updatedAt: nowIso })
      .where(eq(brokerOrder.id, brokerOrderPk));
    throw new Error("broker_order_rejected");
  }

  await db
    .update(executionTask)
    .set({ status: "waiting_ack", updatedAt: nowIso })
    .where(eq(executionTask.id, input.executionTaskId));

  return {
    brokerOrderPk,
    externalOrderId,
    fillPrice: live.actualPrice,
    fillQty: live.actualQuantity,
    status: "waiting_ack",
  };
}

export async function dispatchExecutionTask(
  db: DbClient,
  input: DispatchExecutionInput,
  nowIso = new Date().toISOString()
): Promise<DispatchExecutionResult> {
  const intents = await db.select().from(orderIntent).where(eq(orderIntent.id, input.orderIntentId)).limit(1);
  const intent = intents[0];
  if (!intent) throw new Error("order_intent_missing");

  let fillPrice = intent.price;
  if (fillPrice === null || !Number.isFinite(fillPrice) || fillPrice <= 0) {
    if (input.dispatchMode === "live" && intent.orderType === "market") {
      fillPrice = 1;
    } else {
      throw new Error("price_required_for_execution");
    }
  }

  if (input.dispatchMode === "live") {
    return dispatchLiveBroker(db, input, intent, fillPrice, nowIso);
  }

  return dispatchBuiltinPaper(db, input, intent, fillPrice, nowIso);
}
