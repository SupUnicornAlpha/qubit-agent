import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import { strategyRuntimeLog } from "../../db/sqlite/schema";

export async function appendStrategyRuntimeLog(
  db: DbClient,
  input: {
    strategyRuntimeId: string;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  await db.insert(strategyRuntimeLog).values({
    id: randomUUID(),
    strategyRuntimeId: input.strategyRuntimeId,
    level: input.level,
    message: input.message,
    payloadJson: input.payload ?? {},
  });
}

export async function listStrategyRuntimeLogs(
  strategyRuntimeId: string,
  limit = 50,
  db?: DbClient
) {
  const client = db ?? (await getDb());
  return client
    .select()
    .from(strategyRuntimeLog)
    .where(eq(strategyRuntimeLog.strategyRuntimeId, strategyRuntimeId))
    .orderBy(desc(strategyRuntimeLog.createdAt))
    .limit(limit);
}
