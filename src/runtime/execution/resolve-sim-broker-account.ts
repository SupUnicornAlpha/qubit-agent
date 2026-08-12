/**
 * Resolve a broker account suitable for sim dispatch (Futu/IB sandbox etc.).
 */

import { and, desc, eq, or } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import type { DbClient } from "../../db/sqlite/client";
import { brokerAccount } from "../../db/sqlite/schema";

export async function resolveDefaultSimBrokerAccountId(
  preferredProvider: "futu" | "ib" | "supermind" | null = "futu",
  db?: DbClient
): Promise<string | null> {
  const client = db ?? (await getDb());
  if (preferredProvider) {
    const rows = await client
      .select({ id: brokerAccount.id })
      .from(brokerAccount)
      .where(
        and(
          eq(brokerAccount.provider, preferredProvider),
          eq(brokerAccount.enabled, true),
          or(eq(brokerAccount.mode, "sandbox"), eq(brokerAccount.mode, "mock"))
        )
      )
      .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt))
      .limit(1);
    if (rows[0]?.id) return rows[0].id;
  }
  const anySandbox = await client
    .select({ id: brokerAccount.id })
    .from(brokerAccount)
    .where(
      and(
        eq(brokerAccount.enabled, true),
        or(eq(brokerAccount.mode, "sandbox"), eq(brokerAccount.mode, "mock"))
      )
    )
    .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt))
    .limit(1);
  return anySandbox[0]?.id ?? null;
}
