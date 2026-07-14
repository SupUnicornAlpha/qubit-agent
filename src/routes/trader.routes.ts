import { Hono } from "hono";
import {
  appendTraderUserMessage,
  cancelTraderOrder,
  ensureTraderSession,
  getTraderContext,
  parseTraderUserCommand,
  placeTraderBracketOrder,
  placeTraderOrder,
  pollTraderFeed,
} from "../runtime/trader/trader-agent-service";
import { cancelTraderWorkflows } from "../runtime/trader/trader-workflow";
import { queryKlines } from "../runtime/market/klines-query";
import { getDb } from "../db/sqlite/client";
import type { OrderSide, OrderType } from "../types/entities";
import {
  normalizeExecutionMarket,
  recordExecutionMark,
} from "../runtime/execution/execution-mark-service";

export const traderRouter = new Hono();

traderRouter.post("/session", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    projectId?: string;
    sessionId?: string;
  };
  if (!body.projectId?.trim() || !body.sessionId?.trim()) {
    return c.json({ ok: false, error: "projectId and sessionId are required" }, 400);
  }
  const session = await ensureTraderSession({
    projectId: body.projectId.trim(),
    sessionId: body.sessionId.trim(),
  });
  return c.json({ ok: true, data: session });
});

/** 取消全部历史实时交易 workflow（软删除，保留审计） */
traderRouter.post("/purge-workflows", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    sessionId?: string;
    projectId?: string;
  };
  const db = await getDb();
  const cancelled = await cancelTraderWorkflows(db, {
    sessionId: body.sessionId?.trim() || undefined,
    projectId: body.projectId?.trim() || undefined,
  });
  return c.json({ ok: true, data: { cancelledIds: cancelled, count: cancelled.length } });
});

traderRouter.get("/context", async (c) => {
  const workflowRunId = c.req.query("workflowRunId")?.trim() ?? "";
  if (!workflowRunId) {
    return c.json({ ok: false, error: "workflowRunId is required" }, 400);
  }
  const messages = await getTraderContext({ workflowRunId });
  return c.json({ ok: true, data: { messages } });
});

traderRouter.post("/context/message", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    workflowRunId?: string;
    text?: string;
    kind?: string;
  };
  if (!body.workflowRunId?.trim() || !body.text?.trim()) {
    return c.json({ ok: false, error: "workflowRunId and text are required" }, 400);
  }
  const data = await appendTraderUserMessage({
    workflowRunId: body.workflowRunId.trim(),
    text: body.text,
    kind: body.kind,
  });
  return c.json({ ok: true, data });
});

traderRouter.post("/orders", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    workflowRunId?: string;
    symbol?: string;
    exchange?: string;
    side?: OrderSide;
    qty?: number;
    price?: number | null;
    orderType?: Extract<OrderType, "market" | "limit">;
    timeframe?: string;
    rationale?: string;
    executionMode?: "paper" | "live";
    strategyRuntimeId?: string;
    signalBarTime?: string;
  };

  if (!body.workflowRunId?.trim()) {
    return c.json({ ok: false, error: "workflowRunId is required" }, 400);
  }
  if (!body.symbol?.trim() || !body.side) {
    return c.json({ ok: false, error: "symbol and side are required" }, 400);
  }

  try {
    let price = body.price;
    if ((body.orderType === "market" || price == null) && body.symbol) {
      const { bars } = await queryKlines({
        symbol: body.symbol,
        exchange: body.exchange,
        timeframe: body.timeframe ?? "1d",
        limit: 2,
      });
      const last = bars[bars.length - 1];
      if (last?.close) {
        price = last.close;
        await recordExecutionMark(await getDb(), {
          market: normalizeExecutionMarket(body.exchange ?? ""),
          symbol: body.symbol,
          price: last.close,
          observedAt: last.timestamp,
          timeframe: body.timeframe ?? "1d",
          source: "trader_order_quote",
        });
      }
    }

    const data = await placeTraderOrder({
      workflowRunId: body.workflowRunId.trim(),
      symbol: body.symbol.trim(),
      exchange: body.exchange?.trim() ?? "",
      side: body.side,
      qty: Number(body.qty ?? 100),
      price: price ?? null,
      orderType: body.orderType ?? "limit",
      timeframe: body.timeframe,
      rationale: body.rationale,
      executionMode: body.executionMode ?? "paper",
      strategyRuntimeId: body.strategyRuntimeId,
      signalBarTime: body.signalBarTime,
    });
    return c.json({ ok: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 400);
  }
});

traderRouter.post("/orders/bracket", async (c) => {
  const body = await c.req.json<{
    workflowRunId?: string;
    symbol?: string;
    exchange?: string;
    side?: OrderSide;
    qty?: number;
    entryOrderType?: "market" | "limit";
    entryLimitPrice?: number;
    takeProfitPrice?: number;
    stopLossPrice?: number;
    timeframe?: string;
    executionMode?: "paper" | "live";
    brokerAccountId?: string;
  }>();
  if (
    !body.workflowRunId || !body.symbol || !body.side || body.qty === undefined ||
    body.takeProfitPrice === undefined || body.stopLossPrice === undefined
  ) return c.json({ ok: false, error: "bracket_order_required_fields_missing" }, 400);
  try {
    const { bars, meta } = await queryKlines({
      symbol: body.symbol,
      exchange: body.exchange,
      timeframe: body.timeframe ?? "1m",
      limit: 2,
    });
    const latest = bars[bars.length - 1];
    if (!latest?.close) return c.json({ ok: false, error: "bracket_reference_price_unavailable" }, 409);
    const market = normalizeExecutionMarket(body.exchange ?? "");
    await recordExecutionMark(await getDb(), {
      market,
      symbol: body.symbol,
      price: latest.close,
      observedAt: latest.timestamp,
      timeframe: meta.timeframe,
      source: meta.dataSource,
    });
    const data = await placeTraderBracketOrder({
      workflowRunId: body.workflowRunId,
      symbol: body.symbol,
      exchange: body.exchange ?? "",
      side: body.side,
      qty: Number(body.qty),
      entryOrderType: body.entryOrderType ?? "market",
      entryReferencePrice: latest.close,
      ...(body.entryOrderType === "limit"
        ? { entryLimitPrice: Number(body.entryLimitPrice ?? latest.close) }
        : {}),
      takeProfitPrice: Number(body.takeProfitPrice),
      stopLossPrice: Number(body.stopLossPrice),
      ...(body.timeframe ? { timeframe: body.timeframe } : {}),
      executionMode: body.executionMode ?? "paper",
      ...(body.brokerAccountId ? { brokerAccountId: body.brokerAccountId } : {}),
    });
    return c.json({ ok: true, data });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

traderRouter.post("/orders/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    orderIntentId?: string;
    brokerOrderId?: string;
    provider?: "futu" | "ib" | "ccxt";
    workflowRunId?: string;
  };
  try {
    const data = await cancelTraderOrder(body);
    return c.json({ ok: true, data });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 400);
  }
});

traderRouter.get("/feed", async (c) => {
  const sessionId = c.req.query("sessionId") ?? "";
  const workflowRunId = c.req.query("workflowRunId") ?? "";
  const symbol = c.req.query("symbol") ?? "";
  const exchange = c.req.query("exchange") ?? "";
  const since = c.req.query("since") ?? undefined;
  const includeNews = c.req.query("includeNews") !== "false";

  if (!sessionId || !workflowRunId || !symbol) {
    return c.json({ ok: false, error: "sessionId, workflowRunId and symbol are required" }, 400);
  }

  const data = await pollTraderFeed({
    sessionId,
    workflowRunId,
    symbol,
    exchange,
    since,
    includeNews,
  });
  return c.json({ ok: true, data });
});

traderRouter.post("/command", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    workflowRunId?: string;
    sessionId?: string;
    symbol?: string;
    exchange?: string;
    timeframe?: string;
    text?: string;
    executionMode?: "paper" | "live";
  };

  if (!body.workflowRunId || !body.text?.trim()) {
    return c.json({ ok: false, error: "workflowRunId and text are required" }, 400);
  }

  await appendTraderUserMessage({
    workflowRunId: body.workflowRunId,
    text: body.text,
    kind: "user_command",
  });

  const parsed = parseTraderUserCommand(body.text);
  if (parsed.action === "unknown") {
    return c.json({ ok: false, error: "unrecognized_command", parsed }, 400);
  }
  if (parsed.action === "ingest") {
    return c.json({
      ok: true,
      data: { action: "ingest", message: "ingest_only" },
      parsed,
    });
  }
  if (parsed.action === "cancel") {
    if (!parsed.orderIntentId) {
      return c.json({ ok: false, error: "cancel_requires_order_intent_id", parsed }, 400);
    }
    const data = await cancelTraderOrder({
      orderIntentId: parsed.orderIntentId,
      workflowRunId: body.workflowRunId,
    });
    return c.json({ ok: true, data, parsed });
  }

  try {
    const data = await placeTraderOrder({
      workflowRunId: body.workflowRunId,
      symbol: body.symbol?.trim() ?? "",
      exchange: body.exchange?.trim() ?? "",
      side: parsed.action,
      qty: parsed.qty ?? 100,
      orderType: "market",
      timeframe: body.timeframe,
      rationale: `user_command:${body.text}`,
      executionMode: body.executionMode ?? "paper",
    });
    return c.json({ ok: true, data, parsed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg, parsed }, 400);
  }
});
