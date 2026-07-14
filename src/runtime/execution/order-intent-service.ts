import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import {
  BUILTIN_PAPER_TRADING_ACCOUNT_ID,
  executionTask,
  orderIntent,
  riskReviewTicket,
} from "../../db/sqlite/schema";
import type {
  OrderSide,
  OrderType,
  RiskDecisionResult,
  TimeInForce,
} from "../../types/entities";
import { appendAuditLog } from "../audit/audit-chain-service";
import { evaluatePreTradeForIntent } from "./pre-trade-risk";

const REVIEW_TICKET_TTL_MS = 86_400_000;

export type DispatchMode = "paper" | "live";

export interface CreateOrderIntentInput {
  workflowRunId: string;
  strategyVersionId: string;
  instrumentId: string;
  side: OrderSide;
  qty: number;
  orderType: OrderType;
  price?: number | null;
  stopPrice?: number | null;
  trailingOffsetPct?: number | null;
  triggerDirection?: "above" | "below" | null;
  parentOrderIntentId?: string | null;
  ocoGroupId?: string | null;
  timeInForce: TimeInForce;
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
  /** 调用方幂等键；缺省使用本次 order_intent id。 */
  clientOrderId?: string | null;
}

export interface CreateOrderIntentResult {
  orderIntentId: string;
  executionTaskId: string | null;
  riskOutcome: RiskDecisionResult;
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
  return appendAuditLog(db, {
    traceId: input.traceId,
    workflowRunId: input.workflowRunId ?? null,
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
  if (!Number.isFinite(input.qty) || input.qty <= 0) {
    throw new Error("order_quantity_must_be_positive");
  }
  const conditional = input.orderType === "stop" || input.orderType === "stop_limit" || input.orderType === "trailing_stop";
  if (
    (input.orderType === "stop" || input.orderType === "stop_limit") &&
    (input.stopPrice == null || !Number.isFinite(input.stopPrice) || input.stopPrice <= 0)
  ) throw new Error("conditional_order_requires_positive_stop_price");
  if (
    input.orderType === "trailing_stop" &&
    (input.trailingOffsetPct == null || !Number.isFinite(input.trailingOffsetPct) || input.trailingOffsetPct <= 0 || input.trailingOffsetPct >= 1)
  ) throw new Error("trailing_stop_requires_offset_between_zero_and_one");
  if (
    (input.orderType === "limit" || conditional) &&
    (input.price == null || !Number.isFinite(input.price) || input.price <= 0)
  ) {
    throw new Error(conditional ? "conditional_order_requires_positive_reference_price" : "limit_order_requires_positive_price");
  }
  const traceId = input.traceId ?? randomUUID();
  const accountId = input.accountId ?? BUILTIN_PAPER_TRADING_ACCOUNT_ID;
  const requestedClientOrderId = input.clientOrderId?.trim() || null;

  if (requestedClientOrderId) {
    const existingIntents = await db
      .select()
      .from(orderIntent)
      .where(eq(orderIntent.clientOrderId, requestedClientOrderId))
      .limit(1);
    const existing = existingIntents[0];
    if (existing) {
      const tasks = await db
        .select()
        .from(executionTask)
        .where(eq(executionTask.orderIntentId, existing.id))
        .limit(1);
      const task = tasks[0];
      const riskOutcome: RiskDecisionResult =
        task?.status === "rejected" || task?.status === "failed"
          ? "block"
          : task?.status === "awaiting_review"
            ? "review"
            : "allow";
      return {
        orderIntentId: existing.id,
        executionTaskId: task?.id ?? null,
        riskOutcome,
        riskReason: task?.lastError ?? "idempotent_replay",
        riskReviewTicketId: null,
      };
    }
  }

  const orderIntentId = randomUUID();
  const dispatchMode = input.dispatchMode ?? "paper";
  const activationStatus = input.parentOrderIntentId
    ? "held"
    : conditional
      ? "waiting_trigger"
      : "active";
  const readyTaskStatus = activationStatus === "held"
    ? "held"
    : activationStatus === "waiting_trigger"
      ? "conditional_wait"
      : "pending";
  await db.insert(orderIntent).values({
    id: orderIntentId,
    workflowRunId: input.workflowRunId,
    strategyVersionId: input.strategyVersionId,
    instrumentId: input.instrumentId,
    side: input.side,
    qty: input.qty,
    orderType: input.orderType,
    price: input.price ?? null,
    stopPrice: input.stopPrice ?? null,
    trailingOffsetPct: input.trailingOffsetPct ?? null,
    trailingAnchorPrice: input.orderType === "trailing_stop" ? input.price ?? null : null,
    triggerDirection: input.triggerDirection ?? null,
    parentOrderIntentId: input.parentOrderIntentId ?? null,
    ocoGroupId: input.ocoGroupId ?? null,
    activationStatus,
    timeInForce: input.timeInForce,
    market: input.market ?? null,
    symbol: input.symbol ?? null,
    timeframe: input.timeframe ?? null,
    strategyRuntimeId: input.strategyRuntimeId ?? null,
    signalBarTime: input.signalBarTime ?? null,
    lifecycleStatus: "created",
    clientOrderId: requestedClientOrderId ?? orderIntentId,
    lifecycleUpdatedAt: new Date().toISOString(),
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
  const riskEvaluatedAt = new Date().toISOString();

  let executionTaskId: string | null = null;
  let riskReviewTicketId: string | null = null;

  if (risk.outcome === "block") {
    await db
      .update(orderIntent)
      .set({ lifecycleStatus: "rejected", lifecycleUpdatedAt: riskEvaluatedAt })
      .where(eq(orderIntent.id, orderIntentId));
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
    await db
      .update(orderIntent)
      .set({ lifecycleStatus: "risk_checked", lifecycleUpdatedAt: riskEvaluatedAt })
      .where(eq(orderIntent.id, orderIntentId));
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
  await db
    .update(orderIntent)
    .set({ lifecycleStatus: "risk_checked", lifecycleUpdatedAt: riskEvaluatedAt })
    .where(eq(orderIntent.id, orderIntentId));
  await db.insert(executionTask).values({
    id: tid,
    orderIntentId,
    accountId,
    status: readyTaskStatus,
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
    detail: { orderIntentId, activationStatus, taskStatus: readyTaskStatus },
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
  const intents = await db.select().from(orderIntent).where(eq(orderIntent.id, t.orderIntentId)).limit(1);
  const intent = intents[0];
  const approvedTaskStatus = intent?.activationStatus === "held"
    ? "held"
    : intent?.activationStatus === "waiting_trigger"
      ? "conditional_wait"
      : "pending";
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
      status: approvedTaskStatus,
      updatedAt: now,
      lastError: null,
    })
    .where(and(eq(executionTask.orderIntentId, t.orderIntentId), eq(executionTask.status, "awaiting_review")));
  await db
    .update(orderIntent)
    .set({ lifecycleStatus: "risk_checked", lifecycleUpdatedAt: now })
    .where(eq(orderIntent.id, t.orderIntentId));

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
  await db
    .update(orderIntent)
    .set({ lifecycleStatus: "rejected", lifecycleUpdatedAt: now })
    .where(eq(orderIntent.id, t.orderIntentId));

  await audit(db, {
    traceId: randomUUID(),
    action: "risk_review_rejected",
    resourceType: "risk_review_ticket",
    resourceId: ticketId,
    detail: { orderIntentId: t.orderIntentId, reviewer },
  });

  return { ok: true };
}
