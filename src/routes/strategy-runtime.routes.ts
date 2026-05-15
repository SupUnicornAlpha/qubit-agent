import { Hono } from "hono";
import { listStrategyRuntimeLogs } from "../runtime/strategy/strategy-runtime-log";
import {
  createStrategyRuntime,
  getStrategyRuntime,
  listStrategyRuntimes,
  startStrategyRuntime,
  stopStrategyRuntime,
} from "../runtime/strategy/strategy-runtime-service";

export const strategyRuntimeRouter = new Hono();

strategyRuntimeRouter.get("/", async (c) => {
  const workflowRunId = c.req.query("workflowRunId");
  const sessionId = c.req.query("sessionId");
  const status = c.req.query("status");
  const data = await listStrategyRuntimes({
    workflowRunId: workflowRunId ?? undefined,
    sessionId: sessionId ?? undefined,
    status: status ?? undefined,
  });
  return c.json({ ok: true, data });
});

strategyRuntimeRouter.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    strategyScriptId?: string;
    market?: string;
    symbol?: string;
    timeframe?: string;
    executionMode?: "paper" | "live";
    brokerAccountId?: string;
    params?: Record<string, unknown>;
    autoStart?: boolean;
  };

  if (!body.strategyScriptId?.trim()) {
    return c.json({ ok: false, error: "strategyScriptId is required" }, 400);
  }
  if (!body.market?.trim() || !body.symbol?.trim()) {
    return c.json({ ok: false, error: "market and symbol are required" }, 400);
  }

  try {
    const row = await createStrategyRuntime({
      strategyScriptId: body.strategyScriptId.trim(),
      market: body.market.trim(),
      symbol: body.symbol.trim(),
      timeframe: body.timeframe,
      executionMode: body.executionMode,
      brokerAccountId: body.brokerAccountId,
      params: body.params,
      autoStart: body.autoStart ?? false,
    });
    return c.json({ ok: true, data: row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ ok: false, error: msg }, 400);
  }
});

strategyRuntimeRouter.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await getStrategyRuntime(id);
  if (!row) return c.json({ ok: false, error: "not_found" }, 404);
  const logs = await listStrategyRuntimeLogs(id, 20);
  return c.json({ ok: true, data: { runtime: row, recentLogs: logs } });
});

strategyRuntimeRouter.get("/:id/logs", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const logs = await listStrategyRuntimeLogs(id, limit);
  return c.json({ ok: true, data: logs });
});

strategyRuntimeRouter.post("/:id/start", async (c) => {
  const id = c.req.param("id");
  const row = await getStrategyRuntime(id);
  if (!row) return c.json({ ok: false, error: "not_found" }, 404);
  await startStrategyRuntime(id);
  const updated = await getStrategyRuntime(id);
  return c.json({ ok: true, data: updated });
});

strategyRuntimeRouter.post("/:id/stop", async (c) => {
  const id = c.req.param("id");
  const row = await getStrategyRuntime(id);
  if (!row) return c.json({ ok: false, error: "not_found" }, 404);
  await stopStrategyRuntime(id);
  const updated = await getStrategyRuntime(id);
  return c.json({ ok: true, data: updated });
});
