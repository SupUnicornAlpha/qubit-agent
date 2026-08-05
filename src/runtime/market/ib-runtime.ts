/**
 * Resolve enabled IB broker_account gateway host/port for historical bars.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { brokerAccount } from "../../db/sqlite/schema";
import type { IbProviderConfig } from "../../types/broker";

export type IbGatewayConfig = {
  host: string;
  port: number;
  clientId: number;
  historyClientId: number;
  accountId?: string;
  accountRef: string;
};

export async function resolveIbGatewayConfig(): Promise<IbGatewayConfig | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(brokerAccount)
    .where(and(eq(brokerAccount.provider, "ib"), eq(brokerAccount.enabled, true)))
    .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt))
    .limit(1);

  const envHost = process.env.QUBIT_IB_HOST?.trim();
  const envPort = Number(process.env.QUBIT_IB_PORT);
  const envClient = Number(process.env.QUBIT_IB_CLIENT_ID);
  const envHistoryClient = Number(process.env.QUBIT_IB_HISTORY_CLIENT_ID);

  const row = rows[0];
  if (!row && !envHost && !Number.isFinite(envPort)) return null;

  const cfg = (row?.providerConfigJson ?? {}) as IbProviderConfig;
  const clientId = Number(cfg.clientId) || (Number.isFinite(envClient) ? envClient : 1) || 1;
  return {
    host: (cfg.host ?? envHost ?? "127.0.0.1").trim() || "127.0.0.1",
    port: Number(cfg.port) || (Number.isFinite(envPort) ? envPort : 7497) || 7497,
    clientId,
    historyClientId:
      (Number.isFinite(envHistoryClient) ? envHistoryClient : 0) || clientId + 50,
    accountId: cfg.accountId,
    accountRef: row?.accountRef ?? "env",
  };
}
