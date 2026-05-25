import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../../config";
import * as schema from "./schema";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

let _db: DbClient | null = null;

function getDbPath(): string {
  return join(config.dataDir, "db", "core.sqlite");
}

export async function getDb(): Promise<DbClient> {
  if (_db) return _db;

  const dbPath = getDbPath();
  await mkdir(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath);

  // === SQLite 并发与性能调优 ===
  //
  // - WAL 让"读不阻塞写"。但 SQLite 写仍是单写者；多个 agent 并发写时第二个会拿不到
  //   写锁。没有 busy_timeout 的话直接 throw 'database is locked'，已被实测出现于 MSA
  //   多 Agent 并发派发场景（orchestrator + research + analyst_* 同时写 agent_step /
  //   a2a_message 时）。把 busy_timeout 设成 10s，绝大多数热路径都能在自动等待内拿到锁。
  // - synchronous=NORMAL 配 WAL 已经足够安全（断电只丢最近一次 checkpoint 内事务）。
  // - mmap_size + cache_size 增大读性能；temp_store=MEMORY 让排序/中间结果走内存。
  sqlite.exec("PRAGMA journal_mode=WAL;");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  sqlite.exec("PRAGMA synchronous=NORMAL;");
  sqlite.exec("PRAGMA busy_timeout=10000;");
  sqlite.exec("PRAGMA temp_store=MEMORY;");
  sqlite.exec("PRAGMA cache_size=-65536;"); // 64 MB
  sqlite.exec("PRAGMA mmap_size=268435456;"); // 256 MB
  sqlite.exec("PRAGMA wal_autocheckpoint=1000;");

  _db = drizzle(sqlite, { schema });
  return _db;
}

export function closeDb(): void {
  _db = null;
}

/**
 * 以串行事务跑一组 async 写操作 —— 任意一步抛错都 ROLLBACK，避免半成品。
 *
 * 为什么不用 `db.transaction(...)`：
 *   drizzle bun-sqlite 的 transaction wrapper 是**同步** callback（依赖 bun:sqlite 原生
 *   `Database.transaction(() => ...)`），把 async 函数塞进去会在第一个 await 之前就
 *   立刻 commit，事务等于没开。所以我们改用手动 `BEGIN IMMEDIATE / COMMIT / ROLLBACK`。
 *
 * 并发：bun:sqlite 单连接同一时刻只能一个 BEGIN，并发 caller 第二个会撞
 * SQLITE_BUSY；靠 client.ts 已经设的 `busy_timeout=10000` 让 SQLite 自动重试。
 * 业务上一个 workflow 的 HITL resolve 同时只有一个，所以 IMMEDIATE 锁等待几乎不出现。
 */
export async function runInTransaction<T>(db: DbClient, fn: () => Promise<T>): Promise<T> {
  await db.run(sql`BEGIN IMMEDIATE`);
  try {
    const result = await fn();
    await db.run(sql`COMMIT`);
    return result;
  } catch (err) {
    try {
      await db.run(sql`ROLLBACK`);
    } catch (rollbackErr) {
      console.error(
        "[db] ROLLBACK failed after transaction error:",
        rollbackErr instanceof Error ? rollbackErr.message : rollbackErr
      );
    }
    throw err;
  }
}
