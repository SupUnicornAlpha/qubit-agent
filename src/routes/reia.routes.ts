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
import {
  cleanupExpiredExecutionConfirmTickets,
  listExecutionConfirmTickets,
  requestExecutionConfirmation,
  verifyConfirmationAndAllowExecute,
} from "../runtime/reia/safety-gate";
import {
  checkBrokerAccountHealth,
  listBrokerAccounts,
  listBrokerEvents,
  upsertBrokerAccount,
} from "../runtime/execution/broker/broker-admin";

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
    provider?: "futu" | "ib" | "ccxt";
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

reiaRouter.get("/safety/tickets/:intentOrderId", async (c) => {
  const intentOrderId = c.req.param("intentOrderId");
  const data = await listExecutionConfirmTickets(intentOrderId);
  return c.json({ ok: true, data });
});

reiaRouter.post("/safety/tickets/cleanup", async (c) => {
  const data = await cleanupExpiredExecutionConfirmTickets();
  return c.json({ ok: true, data });
});

reiaRouter.get("/broker/accounts", async (c) => {
  const provider = c.req.query("provider") as "futu" | "ib" | "ccxt" | undefined;
  const data = await listBrokerAccounts(provider);
  return c.json({ ok: true, data });
});

reiaRouter.post("/broker/accounts/upsert", async (c) => {
  const body = await c.req.json<{
    provider?: "futu" | "ib" | "ccxt";
    accountRef?: string;
    mode?: "mock" | "sandbox" | "live";
    baseUrl?: string;
    providerConfig?: Record<string, unknown>;
    isDefault?: boolean;
    enabled?: boolean;
  }>();
  if (!body.provider || !body.accountRef) {
    return c.json({ ok: false, error: "provider and accountRef are required" }, 400);
  }
  const data = await upsertBrokerAccount({
    provider: body.provider,
    accountRef: body.accountRef,
    mode: body.mode,
    baseUrl: body.baseUrl,
    providerConfig: body.providerConfig as import("../types/broker").BrokerProviderConfig | undefined,
    isDefault: body.isDefault,
    enabled: body.enabled,
  });
  return c.json({ ok: true, data });
});

reiaRouter.post("/broker/health-check", async (c) => {
  const body = await c.req.json<{ provider?: "futu" | "ib"; accountRef?: string }>();
  if (!body.provider || !body.accountRef) {
    return c.json({ ok: false, error: "provider and accountRef are required" }, 400);
  }
  const data = await checkBrokerAccountHealth({ provider: body.provider, accountRef: body.accountRef });
  return c.json({ ok: true, data });
});

reiaRouter.get("/broker/events", async (c) => {
  const provider = c.req.query("provider") as "futu" | "ib" | "ccxt" | undefined;
  const limit = Number(c.req.query("limit") ?? 100);
  const data = await listBrokerEvents(provider, Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100);
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
