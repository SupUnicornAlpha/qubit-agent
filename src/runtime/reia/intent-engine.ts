import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { brokerAccount, brokerOrderEvent, executionReport, intentDeviation, intentOrder } from "../../db/sqlite/schema";
import type { BrokerProvider } from "./broker-connector";
import { createBrokerConnector, getBrokerConnector } from "./broker-connector";
import { executeWithPolicy } from "../external-call/policy";

const DEFAULT_DEVIATION_THRESHOLD = 0.015; // 1.5%

export async function createIntentOrder(input: {
  workflowRunId: string;
  ticker: string;
  direction: "long" | "short" | "close";
  quantity: number;
  targetPrice: number;
  rationale?: string;
  expectedReturn?: number;
  expectedRisk?: number;
}) {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(intentOrder).values({
    id,
    workflowRunId: input.workflowRunId,
    createdByInstanceId: null,
    ticker: input.ticker,
    direction: input.direction,
    quantity: input.quantity,
    targetPrice: input.targetPrice,
    rationale: input.rationale ?? "",
    expectedReturn: input.expectedReturn ?? null,
    expectedRisk: input.expectedRisk ?? null,
    status: "approved",
    riskApprovedAt: new Date().toISOString(),
  });
  return { id };
}

export async function executeIntentPaper(input: {
  intentOrderId: string;
  deviationThreshold?: number;
}) {
  const db = await getDb();
  const rows = await db.select().from(intentOrder).where(eq(intentOrder.id, input.intentOrderId)).limit(1);
  const intent = rows[0];
  if (!intent) throw new Error("intent order not found");

  const simulatedLatency = Math.floor(120 + Math.random() * 600);
  const slipPct = (Math.random() - 0.5) * 0.04; // -2% ~ +2%
  const actualPrice = Number((intent.targetPrice * (1 + slipPct)).toFixed(4));
  const qtySlipPct = (Math.random() - 0.5) * 0.06; // -3% ~ +3%
  const actualQty = Number((intent.quantity * (1 + qtySlipPct)).toFixed(4));
  const slippage = Number((actualPrice - intent.targetPrice).toFixed(6));

  const reportId = randomUUID();
  await db.insert(executionReport).values({
    id: reportId,
    intentOrderId: intent.id,
    executorInstanceId: null,
    actualPrice,
    actualQuantity: actualQty,
    slippage,
    executionTimeMs: simulatedLatency,
    brokerOrderId: `paper-${Date.now()}`,
    status: "filled",
  });

  const priceDeviationPct = Math.abs((actualPrice - intent.targetPrice) / intent.targetPrice);
  const quantityDeviationPct = Math.abs((actualQty - intent.quantity) / intent.quantity);
  const threshold = input.deviationThreshold ?? DEFAULT_DEVIATION_THRESHOLD;
  const exceeded = priceDeviationPct >= threshold || quantityDeviationPct >= threshold;

  const deviationId = randomUUID();
  await db.insert(intentDeviation).values({
    id: deviationId,
    intentOrderId: intent.id,
    executionReportId: reportId,
    priceDeviationPct,
    quantityDeviationPct,
    exceededThreshold: exceeded,
    callbackTriggered: exceeded,
    callbackWorkflowId: null,
  });

  await db
    .update(intentOrder)
    .set({ status: exceeded ? "deviated" : "executed" })
    .where(eq(intentOrder.id, intent.id));

  return {
    intentOrderId: intent.id,
    executionReportId: reportId,
    deviationId,
    exceededThreshold: exceeded,
    priceDeviationPct,
    quantityDeviationPct,
    threshold,
  };
}

export async function executeIntentLive(input: {
  intentOrderId: string;
  provider: BrokerProvider;
  deviationThreshold?: number;
}) {
  const db = await getDb();
  const rows = await db.select().from(intentOrder).where(eq(intentOrder.id, input.intentOrderId)).limit(1);
  const intent = rows[0];
  if (!intent) throw new Error("intent order not found");

  const accountRows = await db
    .select()
    .from(brokerAccount)
    .where(and(eq(brokerAccount.provider, input.provider), eq(brokerAccount.enabled, true)))
    .orderBy(desc(brokerAccount.updatedAt))
    .limit(1);
  const account = accountRows[0];
  const connector = account
    ? createBrokerConnector({
        provider: input.provider,
        mode: account.mode,
        accountRef: account.accountRef,
        baseUrl: account.baseUrl ?? undefined,
      })
    : getBrokerConnector(input.provider);
  const side = intent.direction === "short" || intent.direction === "close" ? "sell" : "buy";
  const submittedAt = new Date().toISOString();
  await db.insert(brokerOrderEvent).values({
    id: randomUUID(),
    intentOrderId: intent.id,
    executionReportId: null,
    provider: input.provider,
    eventType: "submit",
    brokerOrderId: null,
    status: "pending",
    detailJson: { ticker: intent.ticker, quantity: intent.quantity, targetPrice: intent.targetPrice, side },
    eventAt: submittedAt,
  });
  const live = await executeWithPolicy(
    {
      scopeKey: `broker:${input.provider}:${intent.ticker}`,
      retry: { maxAttempts: 2, backoffMs: 200, backoffMultiplier: 2 },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 30_000 },
      idempotency: {
        enabled: true,
        key: `broker:${input.provider}:intent:${intent.id}`,
        ttlMs: 15_000,
      },
    },
    async () =>
      connector.submitOrder({
        ticker: intent.ticker,
        side,
        quantity: intent.quantity,
        orderType: "limit",
        limitPrice: intent.targetPrice,
      })
  );

  const slippage = Number((live.actualPrice - intent.targetPrice).toFixed(6));
  const reportId = randomUUID();
  await db.insert(executionReport).values({
    id: reportId,
    intentOrderId: intent.id,
    executorInstanceId: null,
    actualPrice: live.actualPrice,
    actualQuantity: live.actualQuantity,
    slippage,
    executionTimeMs: live.executionTimeMs,
    brokerOrderId: live.brokerOrderId,
    status: live.status === "filled" ? "filled" : live.status === "rejected" ? "rejected" : "cancelled",
  });
  await db.insert(brokerOrderEvent).values({
    id: randomUUID(),
    intentOrderId: intent.id,
    executionReportId: reportId,
    provider: input.provider,
    eventType: live.status === "filled" ? "fill" : live.status === "rejected" ? "reject" : "ack",
    brokerOrderId: live.brokerOrderId,
    status: live.status,
    detailJson: live.raw ?? {},
    eventAt: new Date().toISOString(),
  });

  const priceDeviationPct = Math.abs((live.actualPrice - intent.targetPrice) / intent.targetPrice);
  const quantityDeviationPct = Math.abs((live.actualQuantity - intent.quantity) / intent.quantity);
  const threshold = input.deviationThreshold ?? DEFAULT_DEVIATION_THRESHOLD;
  const exceeded = priceDeviationPct >= threshold || quantityDeviationPct >= threshold;

  const deviationId = randomUUID();
  await db.insert(intentDeviation).values({
    id: deviationId,
    intentOrderId: intent.id,
    executionReportId: reportId,
    priceDeviationPct,
    quantityDeviationPct,
    exceededThreshold: exceeded,
    callbackTriggered: exceeded,
    callbackWorkflowId: null,
  });

  await db
    .update(intentOrder)
    .set({ status: exceeded ? "deviated" : "executed" })
    .where(eq(intentOrder.id, intent.id));

  return {
    intentOrderId: intent.id,
    executionReportId: reportId,
    deviationId,
    exceededThreshold: exceeded,
    priceDeviationPct,
    quantityDeviationPct,
    threshold,
    provider: input.provider,
    brokerOrderId: live.brokerOrderId,
  };
}

export async function listIntentOrders(workflowRunId: string) {
  const db = await getDb();
  return db.select().from(intentOrder).where(eq(intentOrder.workflowRunId, workflowRunId)).orderBy(desc(intentOrder.createdAt));
}

export async function getIntentExecutionView(intentOrderId: string) {
  const db = await getDb();
  const intent = await db.select().from(intentOrder).where(eq(intentOrder.id, intentOrderId)).limit(1);
  const report = await db
    .select()
    .from(executionReport)
    .where(eq(executionReport.intentOrderId, intentOrderId))
    .orderBy(desc(executionReport.createdAt))
    .limit(1);
  const deviation = await db
    .select()
    .from(intentDeviation)
    .where(eq(intentDeviation.intentOrderId, intentOrderId))
    .orderBy(desc(intentDeviation.createdAt))
    .limit(1);
  return {
    intent: intent[0] ?? null,
    report: report[0] ?? null,
    deviation: deviation[0] ?? null,
  };
}
