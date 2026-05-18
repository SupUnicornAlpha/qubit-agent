import { Hono } from "hono";
import {
  cancelTraderOrder,
  ensureTraderSession,
  parseTraderUserCommand,
  placeTraderOrder,
  pollTraderFeed,
} from "../runtime/trader/trader-agent-service";
import { queryKlines } from "../runtime/market/klines-query";

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

traderRouter.post("/orders", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    workflowRunId?: string;
    symbol?: string;
    exchange?: string;
    side?: "buy" | "sell";
    qty?: number;
    price?: number | null;
    orderType?: "market" | "limit";
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
      if (last?.close) price = last.close;
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

traderRouter.post("/orders/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    orderIntentId?: string;
    brokerOrderId?: string;
    provider?: "futu" | "ib" | "ccxt";
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
  const workflowRunId = c.req.query("workflowRunId") ?? undefined;
  const symbol = c.req.query("symbol") ?? "";
  const exchange = c.req.query("exchange") ?? "";
  const since = c.req.query("since") ?? undefined;
  const includeNews = c.req.query("includeNews") !== "false";

  if (!sessionId || !symbol) {
    return c.json({ ok: false, error: "sessionId and symbol are required" }, 400);
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
    const data = await cancelTraderOrder({ orderIntentId: parsed.orderIntentId });
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
