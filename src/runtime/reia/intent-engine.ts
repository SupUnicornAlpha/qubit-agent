import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { executionReport, intentDeviation, intentOrder } from "../../db/sqlite/schema";

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
