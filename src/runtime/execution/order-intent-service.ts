import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  auditLog,
  BUILTIN_PAPER_TRADING_ACCOUNT_ID,
  executionTask,
  orderIntent,
  riskReviewTicket,
} from "../../db/sqlite/schema";
import { evaluatePreTradeForIntent } from "./pre-trade-risk";

const REVIEW_TICKET_TTL_MS = 86_400_000;

export type DispatchMode = "paper" | "live";

export interface CreateOrderIntentInput {
  workflowRunId: string;
  strategyVersionId: string;
  instrumentId: string;
  side: "buy" | "sell";
  qty: number;
  orderType: "market" | "limit" | "stop" | "stop_limit";
  price?: number | null;
  timeInForce: "day" | "gtc" | "ioc" | "fok";
  /** Defaults to built-in paper account from migration 0019. */
  accountId?: string;
  traceId?: string;
  market?: string | null;
  symbol?: string | null;
  timeframe?: string | null;
  strategyRuntimeId?: string | null;
  signalBarTime?: string | null;
  /** paper (default) or live broker dispatch */
  dispatchMode?: DispatchMode;
  brokerAccountId?: string | null;
}

export interface CreateOrderIntentResult {
  orderIntentId: string;
  executionTaskId: string | null;
  riskOutcome: "allow" | "block" | "review";
  riskReason: string;
  riskReviewTicketId: string | null;
}

function audit(
  db: DbClient,
  input: {
    traceId: string;
    workflowRunId?: string;
    action: string;
    resourceType: string;
    resourceId: string;
    detail: Record<string, unknown>;
  }
): Promise<unknown> {
  return db.insert(auditLog).values({
    id: randomUUID(),
    traceId: input.traceId,
    workflowRunId: input.workflowRunId,
    agentInstanceId: null,
    actorType: "system",
    actorId: "execution_pipeline",
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    detailJson: input.detail,
  });
}

export async function createOrderIntentWithExecution(
  db: DbClient,
  input: CreateOrderIntentInput
): Promise<CreateOrderIntentResult> {
  const traceId = input.traceId ?? randomUUID();
  const accountId = input.accountId ?? BUILTIN_PAPER_TRADING_ACCOUNT_ID;

  const orderIntentId = randomUUID();
  const dispatchMode = input.dispatchMode ?? "paper";
  await db.insert(orderIntent).values({
    id: orderIntentId,
    workflowRunId: input.workflowRunId,
    strategyVersionId: input.strategyVersionId,
    instrumentId: input.instrumentId,
    side: input.side,
    qty: input.qty,
    orderType: input.orderType,
    price: input.price ?? null,
    timeInForce: input.timeInForce,
    market: input.market ?? null,
    symbol: input.symbol ?? null,
    timeframe: input.timeframe ?? null,
    strategyRuntimeId: input.strategyRuntimeId ?? null,
    signalBarTime: input.signalBarTime ?? null,
  });

  await audit(db, {
    traceId,
    workflowRunId: input.workflowRunId,
    action: "order_intent_created",
    resourceType: "order_intent",
    resourceId: orderIntentId,
    detail: { workflowRunId: input.workflowRunId, strategyVersionId: input.strategyVersionId },
  });

  const risk = await evaluatePreTradeForIntent(db, orderIntentId);

  let executionTaskId: string | null = null;
  let riskReviewTicketId: string | null = null;

  if (risk.outcome === "block") {
    const tid = randomUUID();
    await db.insert(executionTask).values({
      id: tid,
      orderIntentId,
      accountId,
      status: "rejected",
      traceId,
      lastError: risk.reason,
      retryCount: 0,
      maxRetries: 3,
      dispatchMode,
      brokerAccountId: input.brokerAccountId ?? null,
    });
    executionTaskId = tid;
    await audit(db, {
      traceId,
      workflowRunId: input.workflowRunId,
      action: "execution_task_rejected_by_risk",
      resourceType: "execution_task",
      resourceId: tid,
      detail: { orderIntentId, reason: risk.reason },
    });
    return {
      orderIntentId,
      executionTaskId,
      riskOutcome: risk.outcome,
      riskReason: risk.reason,
      riskReviewTicketId: null,
    };
  }

  if (risk.outcome === "review") {
    const expiresAt = new Date(Date.now() + REVIEW_TICKET_TTL_MS).toISOString();
    riskReviewTicketId = randomUUID();
    await db.insert(riskReviewTicket).values({
      id: riskReviewTicketId,
      orderIntentId,
      status: "open",
      reviewer: null,
      reviewNote: null,
      expiresAt,
    });

    const tid = randomUUID();
    await db.insert(executionTask).values({
      id: tid,
      orderIntentId,
      accountId,
      status: "awaiting_review",
      traceId,
      lastError: null,
      retryCount: 0,
      maxRetries: 3,
      dispatchMode,
      brokerAccountId: input.brokerAccountId ?? null,
    });
    executionTaskId = tid;

    await audit(db, {
      traceId,
      workflowRunId: input.workflowRunId,
      action: "awaiting_risk_review",
      resourceType: "risk_review_ticket",
      resourceId: riskReviewTicketId,
      detail: { orderIntentId, executionTaskId: tid },
    });

    return {
      orderIntentId,
      executionTaskId,
      riskOutcome: risk.outcome,
      riskReason: risk.reason,
      riskReviewTicketId,
    };
  }

  const tid = randomUUID();
  await db.insert(executionTask).values({
    id: tid,
    orderIntentId,
    accountId,
    status: "pending",
    traceId,
    retryCount: 0,
    maxRetries: 3,
    dispatchMode,
    brokerAccountId: input.brokerAccountId ?? null,
  });
  executionTaskId = tid;

  await audit(db, {
    traceId,
    workflowRunId: input.workflowRunId,
    action: "execution_task_enqueued",
    resourceType: "execution_task",
    resourceId: tid,
    detail: { orderIntentId },
  });

  return {
    orderIntentId,
    executionTaskId: tid,
    riskOutcome: risk.outcome,
    riskReason: risk.reason,
    riskReviewTicketId: null,
  };
}

export async function approveRiskReviewTicket(
  db: DbClient,
  ticketId: string,
  reviewer: string,
  note?: string
): Promise<{ ok: boolean; error?: string }> {
  const rows = await db.select().from(riskReviewTicket).where(eq(riskReviewTicket.id, ticketId)).limit(1);
  const t = rows[0];
  if (!t) return { ok: false, error: "ticket_not_found" };
  if (t.status !== "open") return { ok: false, error: "ticket_not_open" };

  const now = new Date().toISOString();
  await db
    .update(riskReviewTicket)
    .set({
      status: "approved",
      reviewer,
      reviewNote: note ?? "",
      updatedAt: now,
    })
    .where(eq(riskReviewTicket.id, ticketId));

  await db
    .update(executionTask)
    .set({
      status: "pending",
      updatedAt: now,
      lastError: null,
    })
    .where(and(eq(executionTask.orderIntentId, t.orderIntentId), eq(executionTask.status, "awaiting_review")));

  await audit(db, {
    traceId: randomUUID(),
    action: "risk_review_approved",
    resourceType: "risk_review_ticket",
    resourceId: ticketId,
    detail: { orderIntentId: t.orderIntentId, reviewer },
  });

  return { ok: true };
}

export async function rejectRiskReviewTicket(
  db: DbClient,
  ticketId: string,
  reviewer: string,
  note?: string
): Promise<{ ok: boolean; error?: string }> {
  const rows = await db.select().from(riskReviewTicket).where(eq(riskReviewTicket.id, ticketId)).limit(1);
  const t = rows[0];
  if (!t) return { ok: false, error: "ticket_not_found" };
  if (t.status !== "open") return { ok: false, error: "ticket_not_open" };

  const now = new Date().toISOString();
  await db
    .update(riskReviewTicket)
    .set({
      status: "rejected",
      reviewer,
      reviewNote: note ?? "",
      updatedAt: now,
    })
    .where(eq(riskReviewTicket.id, ticketId));

  await db
    .update(executionTask)
    .set({
      status: "rejected",
      updatedAt: now,
      lastError: note ?? "rejected_by_reviewer",
    })
    .where(and(eq(executionTask.orderIntentId, t.orderIntentId), eq(executionTask.status, "awaiting_review")));

  await audit(db, {
    traceId: randomUUID(),
    action: "risk_review_rejected",
    resourceType: "risk_review_ticket",
    resourceId: ticketId,
    detail: { orderIntentId: t.orderIntentId, reviewer },
  });

  return { ok: true };
}
