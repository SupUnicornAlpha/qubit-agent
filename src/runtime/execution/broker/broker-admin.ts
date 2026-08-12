/**
 * Broker 账户管理 / 健康检查（execution 层）。
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { brokerAccount, brokerOrderEvent } from "../../../db/sqlite/schema";
import type { BrokerProvider, BrokerProviderConfig } from "../../../types/broker";
import { applyFutuAccountDefaults, ensureFutuRuntime } from "../../market/futu-runtime";
import { brokerHealthCheck, connectorForAccount, resolveBrokerAccount } from "./broker-service";

export async function listBrokerAccounts(provider?: BrokerProvider) {
  const db = await getDb();
  const rows = await db.select().from(brokerAccount).orderBy(desc(brokerAccount.updatedAt));
  if (!provider) return rows;
  return rows.filter((row) => row.provider === provider);
}

export async function upsertBrokerAccount(input: {
  provider: BrokerProvider;
  accountRef: string;
  mode?: "mock" | "sandbox" | "live";
  baseUrl?: string;
  providerConfig?: BrokerProviderConfig;
  isDefault?: boolean;
  enabled?: boolean;
}) {
  const db = await getDb();
  const futuDefaults = applyFutuAccountDefaults({
    provider: input.provider,
    mode: input.mode,
    baseUrl: input.baseUrl,
  });
  const baseUrl = futuDefaults.baseUrl ?? input.baseUrl;

  if (input.isDefault) {
    await db
      .update(brokerAccount)
      .set({ isDefault: false, updatedAt: new Date().toISOString() })
      .where(eq(brokerAccount.provider, input.provider));
  }

  const existed = await db
    .select()
    .from(brokerAccount)
    .where(
      and(
        eq(brokerAccount.provider, input.provider),
        eq(brokerAccount.accountRef, input.accountRef)
      )
    )
    .limit(1);
  if (existed[0]) {
    await db
      .update(brokerAccount)
      .set({
        mode: input.mode ?? existed[0].mode,
        baseUrl: baseUrl ?? existed[0].baseUrl,
        providerConfigJson: input.providerConfig ?? existed[0].providerConfigJson,
        isDefault: input.isDefault ?? existed[0].isDefault,
        enabled: input.enabled ?? existed[0].enabled,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(brokerAccount.id, existed[0].id));
    const rows = await db
      .select()
      .from(brokerAccount)
      .where(eq(brokerAccount.id, existed[0].id))
      .limit(1);
    if (input.provider === "futu" && (input.enabled ?? existed[0].enabled) !== false) {
      void ensureFutuRuntime().catch(() => undefined);
    }
    return rows[0];
  }
  const id = randomUUID();
  await db.insert(brokerAccount).values({
    id,
    provider: input.provider,
    accountRef: input.accountRef,
    mode: input.mode ?? "mock",
    baseUrl: baseUrl ?? null,
    providerConfigJson: input.providerConfig ?? {},
    isDefault: input.isDefault ?? false,
    enabled: input.enabled ?? true,
    healthStatus: "unknown",
  });
  const rows = await db.select().from(brokerAccount).where(eq(brokerAccount.id, id)).limit(1);
  if (input.provider === "futu" && (input.enabled ?? true)) {
    void ensureFutuRuntime().catch(() => undefined);
  }
  return rows[0];
}

export async function checkBrokerAccountHealth(input: {
  provider: BrokerProvider;
  accountRef: string;
}) {
  const db = await getDb();
  const account = await resolveBrokerAccount(input.provider, input.accountRef);
  if (!account) throw new Error("broker account not found");

  const connector = connectorForAccount(account);
  const health = await connector.healthCheck();
  await db
    .update(brokerAccount)
    .set({
      healthStatus: health.status,
      healthMessage: health.message,
      lastHealthAt: health.checkedAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(brokerAccount.id, account.id));
  await db.insert(brokerOrderEvent).values({
    id: randomUUID(),
    intentOrderId: null,
    executionReportId: null,
    provider: account.provider,
    eventType: "health_check",
    brokerOrderId: null,
    status: health.status,
    detailJson: {
      accountRef: account.accountRef,
      message: health.message,
      latencyMs: health.latencyMs,
    },
    eventAt: health.checkedAt,
  });
  return health;
}

export async function listBrokerEvents(provider?: BrokerProvider, limit = 100) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(brokerOrderEvent)
    .orderBy(desc(brokerOrderEvent.createdAt))
    .limit(limit);
  if (!provider) return rows;
  return rows.filter((row) => row.provider === provider);
}

/**
 * Ingest a normalized callback from a Connector/Sidecar.  The callback is
 * append-only; it never changes an order or synthesizes a fill. This keeps
 * IB's async `openOrder/orderStatus` and other venue streams auditable.
 */
export async function recordBrokerSidecarEvent(input: {
  provider: BrokerProvider;
  eventType: "submit" | "ack" | "partial_fill" | "fill" | "cancel" | "modify" | "reject";
  brokerOrderId?: string;
  intentOrderId?: string;
  status?: string;
  eventAt?: string;
  detail?: Record<string, unknown>;
}) {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(brokerOrderEvent).values({
    id,
    provider: input.provider,
    eventType: input.eventType,
    brokerOrderId: input.brokerOrderId ?? null,
    intentOrderId: input.intentOrderId ?? null,
    executionReportId: null,
    status: input.status ?? "ok",
    detailJson: input.detail ?? {},
    eventAt: input.eventAt ?? new Date().toISOString(),
  });
  return { id };
}

export { brokerHealthCheck, resolveBrokerAccount };
