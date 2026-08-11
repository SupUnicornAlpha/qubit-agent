import { Hono } from "hono";
import {
  ingestTradingNewsEvent,
  isSimEventReactorRunning,
} from "../runtime/trading/sim-event-reactor";

/**
 * Sim / event-driven trading hooks (Futu sandbox etc.).
 * Fast path: tick strategy_runtime for mentioned symbols (no LLM).
 * Optional: wake autonomous trading Agent with thin payload.
 */
export const tradingEventsRouter = new Hono();

tradingEventsRouter.post("/news", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    symbols?: string[];
    symbol?: string;
    headline?: string;
    source?: string;
    wakeAgent?: boolean;
    projectId?: string;
    sessionId?: string;
  };
  const symbols = [
    ...(Array.isArray(body.symbols) ? body.symbols : []),
    ...(body.symbol ? [body.symbol] : []),
  ]
    .map((s) => String(s).trim())
    .filter(Boolean);
  const headline = String(body.headline ?? "").trim();
  if (!symbols.length) {
    return c.json({ ok: false, error: "symbols or symbol is required" }, 400);
  }
  if (!headline) {
    return c.json({ ok: false, error: "headline is required" }, 400);
  }
  try {
    const data = await ingestTradingNewsEvent({
      symbols,
      headline,
      ...(body.source !== undefined ? { source: body.source } : {}),
      ...(body.wakeAgent !== undefined ? { wakeAgent: body.wakeAgent } : {}),
      ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
    });
    return c.json({ ok: true, data });
  } catch (e) {
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      400
    );
  }
});

tradingEventsRouter.get("/reactor", (c) => {
  return c.json({ ok: true, data: { running: isSimEventReactorRunning() } });
});
