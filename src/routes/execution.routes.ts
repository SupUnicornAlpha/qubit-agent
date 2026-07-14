import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import {
  brokerOrder,
  brokerAccount,
  executionTask,
  executionTaskEvent,
  fill,
  indicatorStrategyScript,
  instrument,
  orderIntent,
  recommendationSnapshot,
  riskHitLog,
  strategy,
  strategyRuntime,
  strategyVersion,
  workflowRun,
} from "../db/sqlite/schema";
import {
  approveRiskReviewTicket,
  createOrderIntentWithExecution,
  rejectRiskReviewTicket,
  type CreateOrderIntentInput,
} from "../runtime/execution/order-intent-service";
import { buildProjectTcaReport } from "../runtime/execution/tca-service";
import {
  buildPositionReconciliation,
  scanPositionReconciliation,
} from "../runtime/execution/position-reconciliation-service";
import {
  allocatePortfolio,
  type PortfolioAllocationConfig,
  type PortfolioAllocationRow,
  type PortfolioCandidate,
} from "../runtime/execution/portfolio-allocation-service";
import { buildHistoricalPortfolioRisk } from "../runtime/execution/portfolio-risk-service";
import { verifyAuditLogChain } from "../runtime/audit/audit-chain-service";
import { ensureStrategyVersionForScript } from "../runtime/strategy/strategy-version-resolver";
import { amendWaitingConditionalOrder } from "../runtime/execution/conditional-order-service";
import { strategyPromotionService } from "../runtime/effect-validation/strategy-promotion-service";
import { createBracketOrder, type CreateBracketOrderInput } from "../runtime/execution/bracket-order-service";
import {
  buildPortfolioRebalancePlan,
  executePortfolioRebalance,
} from "../runtime/execution/portfolio-rebalance-service";

export const executionRouter = new Hono();

executionRouter.get("/audit/verify", async (c) => {
  const workflowRunId = c.req.query("workflowRunId")?.trim();
  const traceId = c.req.query("traceId")?.trim();
  if (!workflowRunId && !traceId) {
    return c.json({ ok: false, error: "workflowRunId or traceId is required" }, 400);
  }
  const db = await getDb();
  const data = await verifyAuditLogChain(db, {
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(traceId ? { traceId } : {}),
  });
  return c.json({ ok: true, data });
});

executionRouter.post("/reconciliation/positions/remediate", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    provider?: "futu" | "ib" | "ccxt";
    accountRef?: string;
    expectedPlanHash?: string;
    confirmation?: string;
    strategyRuntimeId?: string;
    workflowRunId?: string;
    strategyVersionId?: string;
    brokerAccountId?: string;
  }>();
  if (
    !body.projectId || !body.provider || !body.expectedPlanHash ||
    (!body.strategyRuntimeId && (!body.workflowRunId || !body.strategyVersionId || !body.brokerAccountId))
  ) {
    return c.json({
      ok: false,
      error: "projectId, provider and expectedPlanHash plus strategyRuntimeId or explicit execution context are required",
    }, 400);
  }
  if (body.confirmation !== "CONFIRM_RECONCILIATION") {
    return c.json({ ok: false, error: "explicit confirmation is required" }, 409);
  }
  const current = await scanPositionReconciliation({
    projectId: body.projectId,
    provider: body.provider,
    ...(body.accountRef ? { accountRef: body.accountRef } : {}),
  });
  if (current.remediation.planHash !== body.expectedPlanHash) {
    return c.json({ ok: false, error: "reconciliation_plan_stale", data: current.remediation }, 409);
  }
  if (!current.remediation.actions.length) {
    return c.json({ ok: true, data: { planHash: current.remediation.planHash, orders: [] } });
  }
  const db = await getDb();
  let workflowRunId = body.workflowRunId?.trim() ?? "";
  let strategyVersionId = body.strategyVersionId?.trim() ?? "";
  let brokerAccountId = body.brokerAccountId?.trim() ?? "";
  if (body.strategyRuntimeId) {
    const runtimes = await db
      .select()
      .from(strategyRuntime)
      .where(eq(strategyRuntime.id, body.strategyRuntimeId))
      .limit(1);
    const runtime = runtimes[0];
    if (!runtime || runtime.executionMode !== "live" || !runtime.brokerAccountId) {
      return c.json({ ok: false, error: "eligible_live_strategy_runtime_not_found" }, 409);
    }
    try {
      await strategyPromotionService.assertRuntimeLiveEligible(runtime.id, db);
    } catch (error) {
      return c.json({
        ok: false,
        error: error instanceof Error ? error.message : "live_promotion_gate_blocked",
      }, 409);
    }
    const scripts = await db
      .select()
      .from(indicatorStrategyScript)
      .where(eq(indicatorStrategyScript.id, runtime.strategyScriptId))
      .limit(1);
    const script = scripts[0];
    if (!script) return c.json({ ok: false, error: "strategy_script_not_found" }, 409);
    const resolvedContext = await ensureStrategyVersionForScript(db, script);
    workflowRunId = resolvedContext.workflowRunId;
    strategyVersionId = resolvedContext.strategyVersionId;
    brokerAccountId = runtime.brokerAccountId;
  } else {
    const assessment = await strategyPromotionService.assess(strategyVersionId, db);
    if (!assessment.liveEligible) {
      return c.json({ ok: false, error: "live_promotion_gate_blocked", data: assessment }, 409);
    }
  }

  const executionContexts = await db
    .select({
      workflowProjectId: workflowRun.projectId,
      strategyProjectId: strategy.projectId,
      versionWorkflowRunId: strategyVersion.workflowRunId,
    })
    .from(workflowRun)
    .innerJoin(strategyVersion, eq(strategyVersion.id, strategyVersionId))
    .innerJoin(strategy, eq(strategy.id, strategyVersion.strategyId))
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  const executionContext = executionContexts[0];
  if (
    !executionContext ||
    executionContext.workflowProjectId !== body.projectId ||
    executionContext.strategyProjectId !== body.projectId ||
    (executionContext.versionWorkflowRunId && executionContext.versionWorkflowRunId !== workflowRunId)
  ) {
    return c.json({ ok: false, error: "execution_context_project_mismatch" }, 409);
  }

  const brokerAccounts = await db
    .select()
    .from(brokerAccount)
    .where(eq(brokerAccount.id, brokerAccountId))
    .limit(1);
  const broker = brokerAccounts[0];
  if (!broker || !broker.enabled || broker.provider !== body.provider) {
    return c.json({ ok: false, error: "broker_account_not_found_or_provider_mismatch" }, 409);
  }
  const resolved: Array<{
    action: (typeof current.remediation.actions)[number];
    instrumentId: string;
  }> = [];
  for (const action of current.remediation.actions) {
    const normalizedSymbol = action.symbol.trim().toUpperCase();
    const symbolCandidates = Array.from(new Set([
      action.symbol.trim(),
      normalizedSymbol,
      normalizedSymbol.split(".")[0] ?? normalizedSymbol,
    ].filter(Boolean)));
    const rows = await db
      .select({ id: instrument.id })
      .from(instrument)
      .where(inArray(instrument.symbol, symbolCandidates))
      .limit(1);
    if (!rows[0]) return c.json({ ok: false, error: "instrument_not_found:" + action.symbol }, 409);
    resolved.push({ action, instrumentId: rows[0].id });
  }
  const orders = [];
  for (const item of resolved) {
    const referencePrice = item.action.quantity > 0
      ? item.action.estimatedNotional / item.action.quantity
      : null;
    if (!referencePrice || !Number.isFinite(referencePrice) || referencePrice <= 0) {
      return c.json({ ok: false, error: "invalid_reconciliation_reference_price:" + item.action.symbol }, 409);
    }
    orders.push(await createOrderIntentWithExecution(db, {
      workflowRunId,
      strategyVersionId,
      instrumentId: item.instrumentId,
      side: item.action.action,
      qty: item.action.quantity,
      orderType: "market",
      price: referencePrice,
      timeInForce: "day",
      dispatchMode: "live",
      brokerAccountId,
      symbol: item.action.symbol,
      clientOrderId: "reconcile:" + current.remediation.planHash + ":" + item.action.symbol,
      traceId: "reconcile:" + current.remediation.planHash,
    }));
  }
  return c.json({
    ok: true,
    data: {
      planHash: current.remediation.planHash,
      orders,
      note: "orders entered the normal risk/HITL execution pipeline",
    },
  });
});

executionRouter.post("/portfolio/plan", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    candidates?: PortfolioCandidate[];
    overrides?: Record<string, Partial<PortfolioCandidate>>;
    config?: PortfolioAllocationConfig;
    includeHistoricalRisk?: boolean;
  }>();
  if (!body.config || !Number.isFinite(body.config.capital) || body.config.capital <= 0) {
    return c.json({ ok: false, error: "config.capital must be greater than zero" }, 400);
  }
  let candidates = Array.isArray(body.candidates) ? body.candidates : [];
  if (!candidates.length && body.projectId) {
    const db = await getDb();
    const recommendations = await db
      .select()
      .from(recommendationSnapshot)
      .where(
        and(
          eq(recommendationSnapshot.projectId, body.projectId),
          eq(recommendationSnapshot.status, "active"),
        ),
      )
      .orderBy(desc(recommendationSnapshot.asof));
    const seen = new Set<string>();
    candidates = recommendations.flatMap((recommendation) => {
      const symbol = recommendation.symbol.trim().toUpperCase();
      if (recommendation.side === "neutral" || seen.has(symbol)) return [];
      const price = recommendation.entryLow != null && recommendation.entryHigh != null
        ? (recommendation.entryLow + recommendation.entryHigh) / 2
        : recommendation.entryLow ?? recommendation.entryHigh;
      if (price == null || !Number.isFinite(price) || price <= 0) return [];
      seen.add(symbol);
      const override = body.overrides?.[symbol] ?? {};
      return [{
        symbol,
        side: recommendation.side,
        price,
        stopLoss: recommendation.stopLoss,
        confidence: recommendation.confidence,
        score: recommendation.score,
        proposedWeight: recommendation.positionSizePct == null
          ? null
          : recommendation.positionSizePct > 1
            ? recommendation.positionSizePct / 100
            : recommendation.positionSizePct,
        ...override,
      } satisfies PortfolioCandidate];
    });
  }
  if (!candidates.length) {
    return c.json({ ok: false, error: "candidates are required or no allocatable active recommendations exist" }, 400);
  }
  const data = allocatePortfolio(candidates, body.config);
  const risk = body.includeHistoricalRisk === false
    ? null
    : await buildHistoricalPortfolioRisk({
        capital: body.config.capital,
        rows: data.rows,
        candidates,
      });
  if (risk?.weightedAverageCorrelation != null) {
    data.exposures.weightedAverageCorrelation = risk.weightedAverageCorrelation;
  }
  return c.json({ ok: true, data: { ...data, risk } });
});

executionRouter.post("/portfolio/rebalance/plan", async (c) => {
  const body = await c.req.json<{ rows?: PortfolioAllocationRow[] }>();
  if (!Array.isArray(body.rows)) return c.json({ ok: false, error: "rows are required" }, 400);
  return c.json({ ok: true, data: buildPortfolioRebalancePlan(body.rows) });
});

executionRouter.post("/portfolio/rebalance/execute", async (c) => {
  const body = await c.req.json<{
    workflowRunId?: string;
    market?: string;
    rows?: PortfolioAllocationRow[];
    expectedPlanHash?: string;
    confirmation?: string;
  }>();
  if (!body.workflowRunId || !body.market || !Array.isArray(body.rows) || !body.expectedPlanHash) {
    return c.json({ ok: false, error: "workflowRunId, market, rows and expectedPlanHash are required" }, 400);
  }
  if (body.confirmation !== "CONFIRM_PORTFOLIO_REBALANCE") {
    return c.json({ ok: false, error: "explicit portfolio rebalance confirmation is required" }, 409);
  }
  try {
    const data = await executePortfolioRebalance(await getDb(), {
      workflowRunId: body.workflowRunId,
      market: body.market,
      rows: body.rows,
      expectedPlanHash: body.expectedPlanHash,
      dispatchMode: "paper",
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409);
  }
});

executionRouter.get("/tca", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ ok: false, error: "projectId is required" }, 400);
  const since = c.req.query("since");
  const data = await buildProjectTcaReport({
    projectId,
    ...(since ? { since } : {}),
  });
  return c.json({ ok: true, data });
});

executionRouter.get("/reconciliation/positions", async (c) => {
  const projectId = c.req.query("projectId")?.trim();
  const provider = c.req.query("provider")?.trim();
  if (!projectId || !provider) {
    return c.json({ ok: false, error: "projectId and provider are required" }, 400);
  }
  if (provider !== "futu" && provider !== "ib" && provider !== "ccxt") {
    return c.json({ ok: false, error: "unsupported provider" }, 400);
  }
  const accountRef = c.req.query("accountRef");
  const data = await buildPositionReconciliation({
    projectId,
    provider,
    ...(accountRef ? { accountRef } : {}),
  });
  return c.json({ ok: true, data });
});

executionRouter.post("/reconciliation/positions/scan", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    provider?: "futu" | "ib" | "ccxt";
    accountRef?: string;
  }>();
  if (!body.projectId || !body.provider) {
    return c.json({ ok: false, error: "projectId and provider are required" }, 400);
  }
  const data = await scanPositionReconciliation({
    projectId: body.projectId,
    provider: body.provider,
    ...(body.accountRef ? { accountRef: body.accountRef } : {}),
  });
  return c.json({ ok: true, data });
});

executionRouter.post("/intents", async (c) => {
  const body = await c.req.json<Partial<CreateOrderIntentInput>>();
  if (
    !body.workflowRunId ||
    !body.strategyVersionId ||
    !body.instrumentId ||
    !body.side ||
    body.qty === undefined ||
    !body.orderType ||
    !body.timeInForce
  ) {
    return c.json(
      {
        error:
          "workflowRunId, strategyVersionId, instrumentId, side, qty, orderType, timeInForce are required",
      },
      400
    );
  }
  const db = await getDb();
  try {
    const result = await createOrderIntentWithExecution(db, {
      workflowRunId: body.workflowRunId,
      strategyVersionId: body.strategyVersionId,
      instrumentId: body.instrumentId,
      side: body.side,
      qty: Number(body.qty),
      orderType: body.orderType,
      price: body.price === undefined ? null : Number(body.price),
      timeInForce: body.timeInForce,
      ...(body.stopPrice !== undefined ? { stopPrice: Number(body.stopPrice) } : {}),
      ...(body.trailingOffsetPct !== undefined
        ? { trailingOffsetPct: Number(body.trailingOffsetPct) }
        : {}),
      ...(body.triggerDirection !== undefined ? { triggerDirection: body.triggerDirection } : {}),
      ...(body.parentOrderIntentId !== undefined
        ? { parentOrderIntentId: body.parentOrderIntentId }
        : {}),
      ...(body.ocoGroupId !== undefined ? { ocoGroupId: body.ocoGroupId } : {}),
      ...(body.accountId !== undefined ? { accountId: body.accountId } : {}),
      ...(body.traceId !== undefined ? { traceId: body.traceId } : {}),
      ...(body.clientOrderId !== undefined ? { clientOrderId: body.clientOrderId } : {}),
    });
    return c.json({ ok: true, data: result });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

executionRouter.post("/intents/bracket", async (c) => {
  const body = await c.req.json<Partial<CreateBracketOrderInput>>();
  if (
    !body.workflowRunId ||
    !body.strategyVersionId ||
    !body.instrumentId ||
    !body.side ||
    body.qty === undefined ||
    !body.entryOrderType ||
    body.entryReferencePrice === undefined ||
    body.takeProfitPrice === undefined ||
    body.stopLossPrice === undefined ||
    !body.timeInForce
  ) {
    return c.json({ ok: false, error: "bracket_order_required_fields_missing" }, 400);
  }
  try {
    const db = await getDb();
    const data = await createBracketOrder(db, {
      workflowRunId: body.workflowRunId,
      strategyVersionId: body.strategyVersionId,
      instrumentId: body.instrumentId,
      side: body.side,
      qty: Number(body.qty),
      entryOrderType: body.entryOrderType,
      entryReferencePrice: Number(body.entryReferencePrice),
      ...(body.entryLimitPrice != null ? { entryLimitPrice: Number(body.entryLimitPrice) } : {}),
      takeProfitPrice: Number(body.takeProfitPrice),
      stopLossPrice: Number(body.stopLossPrice),
      timeInForce: body.timeInForce,
      ...(body.accountId ? { accountId: body.accountId } : {}),
      ...(body.dispatchMode ? { dispatchMode: body.dispatchMode } : {}),
      ...(body.brokerAccountId ? { brokerAccountId: body.brokerAccountId } : {}),
      ...(body.market ? { market: body.market } : {}),
      ...(body.symbol ? { symbol: body.symbol } : {}),
      ...(body.clientOrderId ? { clientOrderId: body.clientOrderId } : {}),
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

executionRouter.patch("/intents/:id/conditional", async (c) => {
  const body = await c.req.json<{
    expectedLifecycleUpdatedAt?: string;
    stopPrice?: number;
    trailingOffsetPct?: number;
    triggerDirection?: "above" | "below";
    resetTrailingAnchorPrice?: number;
    actorId?: string;
  }>();
  if (!body.expectedLifecycleUpdatedAt) {
    return c.json({ ok: false, error: "expectedLifecycleUpdatedAt is required" }, 400);
  }
  try {
    const data = await amendWaitingConditionalOrder(await getDb(), {
      orderIntentId: c.req.param("id"),
      expectedLifecycleUpdatedAt: body.expectedLifecycleUpdatedAt,
      ...(body.stopPrice !== undefined ? { stopPrice: Number(body.stopPrice) } : {}),
      ...(body.trailingOffsetPct !== undefined
        ? { trailingOffsetPct: Number(body.trailingOffsetPct) }
        : {}),
      ...(body.triggerDirection ? { triggerDirection: body.triggerDirection } : {}),
      ...(body.resetTrailingAnchorPrice !== undefined
        ? { resetTrailingAnchorPrice: Number(body.resetTrailingAnchorPrice) }
        : {}),
      ...(body.actorId ? { actorId: body.actorId } : {}),
    });
    return c.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, message.endsWith("_stale") ? 409 : 400);
  }
});

executionRouter.get("/intents", async (c) => {
  const workflowRunId = c.req.query("workflowRunId")?.trim();
  const lifecycleStatus = c.req.query("status")?.trim();
  const limitValue = Number(c.req.query("limit") ?? "100");
  const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(500, limitValue)) : 100;
  const db = await getDb();
  const where = and(
    workflowRunId ? eq(orderIntent.workflowRunId, workflowRunId) : undefined,
    lifecycleStatus
      ? eq(
          orderIntent.lifecycleStatus,
          lifecycleStatus as typeof orderIntent.$inferSelect.lifecycleStatus,
        )
      : undefined,
  );
  const data = await db
    .select()
    .from(orderIntent)
    .where(where)
    .orderBy(desc(orderIntent.intentTime))
    .limit(limit);
  return c.json({ ok: true, data });
});

executionRouter.get("/intents/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const intents = await db.select().from(orderIntent).where(eq(orderIntent.id, id)).limit(1);
  const intent = intents[0];
  if (!intent) return c.json({ error: "not_found" }, 404);

  const tasks = await db
    .select()
    .from(executionTask)
    .where(eq(executionTask.orderIntentId, id))
    .limit(1);
  const hits = await db.select().from(riskHitLog).where(eq(riskHitLog.orderIntentId, id));

  return c.json({
    ok: true,
    data: {
      intent,
      executionTask: tasks[0] ?? null,
      riskHitLogs: hits,
    },
  });
});

executionRouter.get("/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const tasks = await db.select().from(executionTask).where(eq(executionTask.id, id)).limit(1);
  const task = tasks[0];
  if (!task) return c.json({ error: "not_found" }, 404);

  const intents = await db
    .select()
    .from(orderIntent)
    .where(eq(orderIntent.id, task.orderIntentId))
    .limit(1);

  const orders = await db
    .select()
    .from(brokerOrder)
    .where(eq(brokerOrder.orderIntentId, task.orderIntentId));
  const fills: unknown[] = [];
  for (const o of orders) {
    const fs = await db.select().from(fill).where(eq(fill.brokerOrderId, o.id));
    fills.push(...fs);
  }

  return c.json({
    ok: true,
    data: {
      task,
      orderIntent: intents[0] ?? null,
      brokerOrders: orders,
      fills,
    },
  });
});

executionRouter.get("/tasks/:id/events", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const events = await db
    .select()
    .from(executionTaskEvent)
    .where(eq(executionTaskEvent.executionTaskId, id));
  return c.json({ ok: true, data: events });
});

executionRouter.post("/review/:ticketId/approve", async (c) => {
  const ticketId = c.req.param("ticketId");
  const body = await c.req.json<{ reviewer?: string; note?: string }>();
  if (!body.reviewer) return c.json({ error: "reviewer is required" }, 400);
  const db = await getDb();
  const result = await approveRiskReviewTicket(db, ticketId, body.reviewer, body.note);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
  return c.json({ ok: true });
});

executionRouter.post("/review/:ticketId/reject", async (c) => {
  const ticketId = c.req.param("ticketId");
  const body = await c.req.json<{ reviewer?: string; note?: string }>();
  if (!body.reviewer) return c.json({ error: "reviewer is required" }, 400);
  const db = await getDb();
  const result = await rejectRiskReviewTicket(db, ticketId, body.reviewer, body.note);
  if (!result.ok) return c.json({ ok: false, error: result.error }, 400);
  return c.json({ ok: true });
});
