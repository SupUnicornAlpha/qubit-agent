import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../db/sqlite/schema";
import { recordExecutionMark, resolveExecutionMark } from "./execution-mark-service";

describe("execution mark service", () => {
  test("prefers a fresh realtime mark and falls back to EOD when stale", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite, { schema });
    const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "../../db/sqlite/migrations");
    await migrate(db, { migrationsFolder });
    await db.insert(schema.dailyMarkPrice).values({
      id: randomUUID(),
      market: "US",
      symbol: "MARK",
      tradingDay: "2026-07-13",
      close: 99,
      source: "eod",
    });
    await recordExecutionMark(db, {
      market: "US",
      symbol: "MARK",
      price: 101,
      observedAt: "2026-07-14T01:00:00Z",
      timeframe: "1m",
      source: "minute",
      fetchedAt: "2026-07-14T01:00:10Z",
    });
    const realtime = await resolveExecutionMark(db, {
      market: "US",
      symbol: "MARK",
      nowIso: "2026-07-14T01:04:00Z",
    });
    expect(realtime?.price).toBe(101);
    expect(realtime?.freshness).toBe("realtime");
    const fallback = await resolveExecutionMark(db, {
      market: "US",
      symbol: "MARK",
      nowIso: "2026-07-14T02:00:00Z",
    });
    expect(fallback?.price).toBe(99);
    expect(fallback?.freshness).toBe("eod_fallback");
  });
});
