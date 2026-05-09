import { Hono } from "hono";
import {
  createIntentOrder,
  executeIntentPaper,
  getIntentExecutionView,
  listIntentOrders,
} from "../runtime/reia/intent-engine";

export const reiaRouter = new Hono();

reiaRouter.post("/intent", async (c) => {
  const body = await c.req.json<{
    workflowRunId: string;
    ticker: string;
    direction: "long" | "short" | "close";
    quantity: number;
    targetPrice: number;
    rationale?: string;
    expectedReturn?: number;
    expectedRisk?: number;
  }>();
  if (!body.workflowRunId || !body.ticker) return c.json({ error: "workflowRunId and ticker are required" }, 400);
  const data = await createIntentOrder(body);
  return c.json({ ok: true, data });
});

reiaRouter.post("/execute", async (c) => {
  const body = await c.req.json<{ intentOrderId: string; deviationThreshold?: number }>();
  if (!body.intentOrderId) return c.json({ error: "intentOrderId is required" }, 400);
  const data = await executeIntentPaper(body);
  return c.json({ ok: true, data });
});

reiaRouter.get("/intents/:workflowRunId", async (c) => {
  const workflowRunId = c.req.param("workflowRunId");
  const data = await listIntentOrders(workflowRunId);
  return c.json({ ok: true, data });
});

reiaRouter.get("/view/:intentOrderId", async (c) => {
  const intentOrderId = c.req.param("intentOrderId");
  const data = await getIntentExecutionView(intentOrderId);
  return c.json({ ok: true, data });
});
