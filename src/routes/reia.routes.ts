import { Hono } from "hono";
import {
  createIntentOrder,
  executeIntentLive,
  executeIntentPaper,
  getIntentExecutionView,
  listIntentOrders,
} from "../runtime/reia/intent-engine";
import {
  loadExecutionSafetyConfig,
  saveExecutionSafetyConfig,
} from "../runtime/config/execution-safety-config";
import { requestExecutionConfirmation, verifyConfirmationAndAllowExecute } from "../runtime/reia/safety-gate";

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

reiaRouter.get("/safety/config", async (c) => {
  const data = await loadExecutionSafetyConfig();
  return c.json({ ok: true, data });
});

reiaRouter.put("/safety/config", async (c) => {
  const body = await c.req.json<{
    dryRunOnly?: boolean;
    requireDoubleConfirm?: boolean;
    confirmTokenTtlSec?: number;
    finalRiskScoreThreshold?: number;
  }>();
  const data = await saveExecutionSafetyConfig(body);
  return c.json({ ok: true, data });
});

reiaRouter.post("/safety/request-confirm", async (c) => {
  const body = await c.req.json<{ intentOrderId: string }>();
  if (!body.intentOrderId) return c.json({ error: "intentOrderId is required" }, 400);
  const data = await requestExecutionConfirmation(body.intentOrderId);
  return c.json({ ok: true, data });
});

reiaRouter.post("/safety/execute-confirmed", async (c) => {
  const body = await c.req.json<{
    intentOrderId: string;
    confirmToken?: string;
    deviationThreshold?: number;
    forceDryRun?: boolean;
    provider?: "futu" | "ib";
  }>();
  if (!body.intentOrderId) return c.json({ error: "intentOrderId is required" }, 400);
  const gate = await verifyConfirmationAndAllowExecute({
    intentOrderId: body.intentOrderId,
    confirmToken: body.confirmToken,
    forceDryRun: body.forceDryRun,
  });
  const data =
    gate.executeMode === "live"
      ? await executeIntentLive({
          intentOrderId: body.intentOrderId,
          deviationThreshold: body.deviationThreshold,
          provider: body.provider ?? "futu",
        })
      : await executeIntentPaper({
          intentOrderId: body.intentOrderId,
          deviationThreshold: body.deviationThreshold,
        });
  return c.json({ ok: true, gate, data });
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
