/**
 * Resolve a broker account suitable for sim dispatch (Futu/IB sandbox etc.).
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { brokerAccount } from "../../db/sqlite/schema";

export async function resolveDefaultSimBrokerAccountId(
  preferredProvider: "futu" | "ib" | "supermind" | null = "futu"
): Promise<string | null> {
  const db = await getDb();
  if (preferredProvider) {
    const rows = await db
      .select({ id: brokerAccount.id })
      .from(brokerAccount)
      .where(
        and(
          eq(brokerAccount.provider, preferredProvider),
          eq(brokerAccount.enabled, true),
          eq(brokerAccount.mode, "sandbox")
        )
      )
      .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt))
      .limit(1);
    if (rows[0]?.id) return rows[0].id;
  }
  const anySandbox = await db
    .select({ id: brokerAccount.id })
    .from(brokerAccount)
    .where(and(eq(brokerAccount.enabled, true), eq(brokerAccount.mode, "sandbox")))
    .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt))
    .limit(1);
  return anySandbox[0]?.id ?? null;
}
