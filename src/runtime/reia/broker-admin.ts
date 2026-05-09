import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { brokerAccount, brokerOrderEvent } from "../../db/sqlite/schema";
import { createBrokerConnector, type BrokerProvider } from "./broker-connector";

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
  enabled?: boolean;
}) {
  const db = await getDb();
  const existed = await db
    .select()
    .from(brokerAccount)
    .where(and(eq(brokerAccount.provider, input.provider), eq(brokerAccount.accountRef, input.accountRef)))
    .limit(1);
  if (existed[0]) {
    await db
      .update(brokerAccount)
      .set({
        mode: input.mode ?? existed[0].mode,
        baseUrl: input.baseUrl ?? existed[0].baseUrl,
        enabled: input.enabled ?? existed[0].enabled,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(brokerAccount.id, existed[0].id));
    const rows = await db.select().from(brokerAccount).where(eq(brokerAccount.id, existed[0].id)).limit(1);
    return rows[0];
  }
  const id = randomUUID();
  await db.insert(brokerAccount).values({
    id,
    provider: input.provider,
    accountRef: input.accountRef,
    mode: input.mode ?? "mock",
    baseUrl: input.baseUrl ?? null,
    enabled: input.enabled ?? true,
    healthStatus: "unknown",
  });
  const rows = await db.select().from(brokerAccount).where(eq(brokerAccount.id, id)).limit(1);
  return rows[0];
}

export async function checkBrokerAccountHealth(input: { provider: BrokerProvider; accountRef: string }) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(brokerAccount)
    .where(and(eq(brokerAccount.provider, input.provider), eq(brokerAccount.accountRef, input.accountRef)))
    .limit(1);
  const account = rows[0];
  if (!account) throw new Error("broker account not found");
  const connector = createBrokerConnector({
    provider: account.provider,
    mode: account.mode,
    accountRef: account.accountRef,
    baseUrl: account.baseUrl ?? undefined,
  });
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
    detailJson: { accountRef: account.accountRef, message: health.message, latencyMs: health.latencyMs },
    eventAt: health.checkedAt,
  });
  return health;
}

export async function listBrokerEvents(provider?: BrokerProvider, limit = 100) {
  const db = await getDb();
  const rows = await db.select().from(brokerOrderEvent).orderBy(desc(brokerOrderEvent.createdAt)).limit(limit);
  if (!provider) return rows;
  return rows.filter((row) => row.provider === provider);
}
