import { Hono } from "hono";
import {
  loadExecutionSafetyConfig,
  saveExecutionSafetyConfig,
} from "../runtime/config/execution-safety-config";
import {
  checkBrokerAccountHealth,
  listBrokerAccounts,
  listBrokerEvents,
  recordBrokerSidecarEvent,
  upsertBrokerAccount,
} from "../runtime/execution/broker/broker-admin";
import {
  createIntentOrder,
  executeIntentPaper,
  getIntentExecutionView,
  listIntentOrders,
} from "../runtime/reia/intent-engine";
import {
  cleanupExpiredExecutionConfirmTickets,
  listExecutionConfirmTickets,
  requestExecutionConfirmation,
  verifyConfirmationAndAllowExecute,
} from "../runtime/reia/safety-gate";
import { type BrokerProvider, type BrokerProviderConfig, isBrokerProvider } from "../types/broker";

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
  if (!body.workflowRunId || !body.ticker)
    return c.json({ error: "workflowRunId and ticker are required" }, 400);
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
    provider?: BrokerProvider;
  }>();
  if (!body.intentOrderId) return c.json({ error: "intentOrderId is required" }, 400);
  const safety = await loadExecutionSafetyConfig();
  // The legacy intent_order schema cannot carry the immutable evidence now
  // required for a live order. Do not consume the legacy confirmation ticket
  // when the caller needs to migrate to the canonical pipeline.
  if (!body.forceDryRun && !safety.dryRunOnly) {
    return c.json(
      {
        ok: false,
        error: "legacy_live_execution_retired",
        hint: "Use POST /api/v1/execution/intents with dispatchMode=live, thesisId, snapshotId and a promotion-qualified strategy version.",
      },
      410
    );
  }
  const gate = await verifyConfirmationAndAllowExecute({
    intentOrderId: body.intentOrderId,
    ...(body.confirmToken !== undefined ? { confirmToken: body.confirmToken } : {}),
    ...(body.forceDryRun !== undefined ? { forceDryRun: body.forceDryRun } : {}),
  });
  const data = await executeIntentPaper({
    intentOrderId: body.intentOrderId,
    ...(body.deviationThreshold !== undefined
      ? { deviationThreshold: body.deviationThreshold }
      : {}),
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
  const providerRaw = c.req.query("provider");
  if (providerRaw && !isBrokerProvider(providerRaw)) {
    return c.json({ ok: false, error: "unsupported provider" }, 400);
  }
  const provider = providerRaw as BrokerProvider | undefined;
  const data = await listBrokerAccounts(provider);
  return c.json({ ok: true, data });
});

reiaRouter.post("/broker/accounts/upsert", async (c) => {
  const body = await c.req.json<{
    provider?: BrokerProvider;
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
  if (!isBrokerProvider(body.provider)) {
    return c.json({ ok: false, error: "unsupported provider" }, 400);
  }
  const data = await upsertBrokerAccount({
    provider: body.provider,
    accountRef: body.accountRef,
    ...(body.mode !== undefined ? { mode: body.mode } : {}),
    ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
    ...(body.providerConfig !== undefined
      ? { providerConfig: body.providerConfig as BrokerProviderConfig }
      : {}),
    ...(body.isDefault !== undefined ? { isDefault: body.isDefault } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
  });
  return c.json({ ok: true, data });
});

reiaRouter.post("/broker/health-check", async (c) => {
  const body = await c.req.json<{ provider?: BrokerProvider; accountRef?: string }>();
  if (!body.provider || !body.accountRef) {
    return c.json({ ok: false, error: "provider and accountRef are required" }, 400);
  }
  if (!isBrokerProvider(body.provider)) {
    return c.json({ ok: false, error: "unsupported provider" }, 400);
  }
  const data = await checkBrokerAccountHealth({
    provider: body.provider,
    accountRef: body.accountRef,
  });
  return c.json({ ok: true, data });
});

reiaRouter.get("/broker/events", async (c) => {
  const providerRaw = c.req.query("provider");
  if (providerRaw && !isBrokerProvider(providerRaw)) {
    return c.json({ ok: false, error: "unsupported provider" }, 400);
  }
  const provider = providerRaw as BrokerProvider | undefined;
  const limit = Number(c.req.query("limit") ?? 100);
  const data = await listBrokerEvents(
    provider,
    Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 100
  );
  return c.json({ ok: true, data });
});

/** Connector/Sidecar callback ingress for async broker order events (not an Agent tool). */
reiaRouter.post("/broker/events", async (c) => {
  const configuredToken = process.env.QUBIT_BROKER_EVENT_TOKEN?.trim();
  if (configuredToken && c.req.header("authorization") !== `Bearer ${configuredToken}`) {
    return c.json({ ok: false, error: "unauthorized" }, 401);
  }
  const body = await c.req.json<{
    provider?: BrokerProvider;
    eventType?: "submit" | "ack" | "partial_fill" | "fill" | "cancel" | "modify" | "reject";
    brokerOrderId?: string;
    intentOrderId?: string;
    status?: string;
    eventAt?: string;
    detail?: Record<string, unknown>;
  }>();
  if (!body.provider || !isBrokerProvider(body.provider) || !body.eventType) {
    return c.json({ ok: false, error: "valid provider and eventType are required" }, 400);
  }
  const data = await recordBrokerSidecarEvent({
    provider: body.provider,
    eventType: body.eventType,
    ...(body.brokerOrderId ? { brokerOrderId: body.brokerOrderId } : {}),
    ...(body.intentOrderId ? { intentOrderId: body.intentOrderId } : {}),
    ...(body.status ? { status: body.status } : {}),
    ...(body.eventAt ? { eventAt: body.eventAt } : {}),
    ...(body.detail ? { detail: body.detail } : {}),
  });
  return c.json({ ok: true, data }, 202);
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
