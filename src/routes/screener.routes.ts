import { Hono } from "hono";
import {
  listScreenerCandidates,
  listScreenerRuns,
  runStockScreener,
} from "../runtime/screener/stock-screener";

export const screenerRouter = new Hono();

screenerRouter.post("/run", async (c) => {
  const body = await c.req.json<{
    workflowRunId: string;
    universe?: "CN-A" | "US" | "HK";
    criteria?: {
      minMarketCapBillion?: number;
      maxPe?: number;
      minMomentum30d?: number;
    };
    topN?: number;
  }>();
  if (!body.workflowRunId) {
    return c.json({ error: "workflowRunId is required" }, 400);
  }
  const data = await runStockScreener(body);
  return c.json({ ok: true, data });
});

screenerRouter.get("/runs/:workflowRunId", async (c) => {
  const workflowRunId = c.req.param("workflowRunId");
  const data = await listScreenerRuns(workflowRunId);
  return c.json({ ok: true, data });
});

screenerRouter.get("/candidates/:screenerRunId", async (c) => {
  const screenerRunId = c.req.param("screenerRunId");
  const data = await listScreenerCandidates(screenerRunId);
  return c.json({ ok: true, data });
});
