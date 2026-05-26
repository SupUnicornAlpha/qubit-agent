import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { brokerAccount, brokerOrderEvent } from "../../db/sqlite/schema";
import type { BrokerProvider, BrokerProviderConfig } from "../../types/broker";
import {
  createBrokerConnector,
  paperFromBrokerMode,
  type BrokerConnector,
  type BrokerFill,
  type BrokerPosition,
  type BrokerRuntimeConfig,
} from "./broker-connector";

export type ResolvedBrokerAccount = {
  id: string;
  provider: BrokerProvider;
  accountRef: string;
  mode: "mock" | "sandbox" | "live";
  baseUrl: string | null;
  providerConfigJson: BrokerProviderConfig;
  isDefault: boolean;
  enabled: boolean;
};

export async function resolveBrokerAccount(
  provider: BrokerProvider,
  accountRef?: string
): Promise<ResolvedBrokerAccount | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(brokerAccount)
    .where(and(eq(brokerAccount.provider, provider), eq(brokerAccount.enabled, true)))
    .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt));

  if (!rows.length) return null;

  if (accountRef) {
    const exact = rows.find((r) => r.accountRef === accountRef);
    if (exact) return mapAccountRow(exact);
  }

  const defaulted = rows.find((r) => r.isDefault);
  return mapAccountRow(defaulted ?? rows[0]!);
}

function mapAccountRow(row: typeof brokerAccount.$inferSelect): ResolvedBrokerAccount {
  return {
    id: row.id,
    provider: row.provider,
    accountRef: row.accountRef,
    mode: row.mode,
    baseUrl: row.baseUrl,
    providerConfigJson: (row.providerConfigJson ?? {}) as BrokerProviderConfig,
    isDefault: row.isDefault,
    enabled: row.enabled,
  };
}

export function connectorForAccount(account: ResolvedBrokerAccount): BrokerConnector {
  const config: BrokerRuntimeConfig = {
    provider: account.provider,
    mode: account.mode,
    accountRef: account.accountRef,
    baseUrl: account.baseUrl ?? undefined,
    providerConfig: account.providerConfigJson,
    paper: paperFromBrokerMode(account.mode),
  };
  return createBrokerConnector(config);
}

export async function brokerHealthCheck(input: {
  provider: BrokerProvider;
  accountRef: string;
}): Promise<Awaited<ReturnType<BrokerConnector["healthCheck"]>>> {
  const account = await resolveBrokerAccount(input.provider, input.accountRef);
  if (!account) throw new Error("broker account not found");
  const connector = connectorForAccount(account);
  return connector.healthCheck();
}

export async function brokerCancelOrder(input: {
  provider: BrokerProvider;
  accountRef?: string;
  brokerOrderId: string;
  intentOrderId?: string;
}): Promise<void> {
  const account = await resolveBrokerAccount(input.provider, input.accountRef);
  if (!account) throw new Error("broker account not found");
  const connector = connectorForAccount(account);
  await connector.cancelOrder(input.brokerOrderId);
  const db = await getDb();
  await db.insert(brokerOrderEvent).values({
    id: randomUUID(),
    intentOrderId: input.intentOrderId ?? null,
    executionReportId: null,
    provider: input.provider,
    eventType: "cancel",
    brokerOrderId: input.brokerOrderId,
    status: "ok",
    detailJson: { accountRef: account.accountRef },
    eventAt: new Date().toISOString(),
  });
}

export async function brokerGetFills(input: {
  provider: BrokerProvider;
  accountRef?: string;
  brokerOrderId: string;
}): Promise<BrokerFill[]> {
  const account = await resolveBrokerAccount(input.provider, input.accountRef);
  if (!account) throw new Error("broker account not found");
  const connector = connectorForAccount(account);
  return connector.getFills(input.brokerOrderId);
}

export async function brokerGetPositions(input: {
  provider: BrokerProvider;
  accountRef?: string;
}): Promise<BrokerPosition[]> {
  const account = await resolveBrokerAccount(input.provider, input.accountRef);
  if (!account) throw new Error("broker account not found");
  const connector = connectorForAccount(account);
  return connector.getPositions();
}
