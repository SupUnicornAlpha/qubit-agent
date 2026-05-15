import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { strategyRuntime } from "../../db/sqlite/schema";
import { appendStrategyRuntimeLog } from "./strategy-runtime-log";

/** On process start, mark previously running instances as running again (Phase 3). */
export async function restoreRunningStrategies(): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(strategyRuntime)
    .where(eq(strategyRuntime.status, "running"));

  for (const r of rows) {
    await appendStrategyRuntimeLog(db, {
      strategyRuntimeId: r.id,
      level: "info",
      message: "strategy_runtime_restored_after_restart",
    });
  }

  return rows.length;
}
