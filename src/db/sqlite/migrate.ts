/**
 * Drizzle 迁移入口 + sanity drift check。
 *
 * 背景（2026-05-25 故障复盘）：
 *   commit 9684c52 引入 0042_agent_skill / 0043_workflow_hitl 后，Tauri datadir
 *   （~/Library/Application Support/app.qubit.agent/）上的 SQLite 实际 *没有*
 *   apply 这两条；`drizzle.migrate()` 静默成功、依旧打印 "migrations applied"，
 *   但 DDL 从未执行。结果 `workflow_hitl_request` / `agent_skill` 表缺失，
 *   团队研究 + HITL 链路在 backend 内抛 `no such table` 然后整个 workflow
 *   被标 failed —— 前端表现为"拓扑图无事件、对话流无 token"。
 *
 * 防御：启动期对比 `_journal.json` entries 数 与 `__drizzle_migrations` 行数；
 * 不匹配直接抛 `MigrationDriftError` fail-fast，让运维 / 开发能立刻看到，
 * 而不是被一连串 "no such table" 误导。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { config } from "../../config";
import { getBundledMigrationsDir } from "../../runtime/app-paths";
import { getDb } from "./client";

/** 开发：源码旁 migrations；安装包：`$QUBIT_APP_ROOT/db/migrations` */
function migrationsDir(): string {
  const bundled = getBundledMigrationsDir();
  if (existsSync(bundled)) return bundled;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "migrations");
}

export class MigrationDriftError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    public readonly migrationsDir: string
  ) {
    super(
      `migration_drift: drizzle _journal.json has ${expected} entries but ` +
        `__drizzle_migrations table has only ${actual} rows. ` +
        `检查 ${migrationsDir}/meta/_journal.json 是否登记完整；` +
        `修复：QUBIT_DATA_DIR=... bun run db:migrate（停掉 backend 再跑）。`
    );
    this.name = "MigrationDriftError";
  }
}

export async function runMigrations(): Promise<void> {
  const db = await getDb();
  const dir = migrationsDir();
  await migrate(db, { migrationsFolder: dir });

  const expected = readJournalEntryCount(dir);
  const actual = readAppliedMigrationCount();
  if (expected > 0 && actual < expected) {
    throw new MigrationDriftError(expected, actual, dir);
  }
  console.log(`[DB] SQLite migrations applied (${actual}/${expected}).`);
}

/** 读 `_journal.json` 的 entries 数；任何异常返回 0（等价于"跳过检查"） */
export function readJournalEntryCount(dir: string): number {
  try {
    const raw = readFileSync(join(dir, "meta", "_journal.json"), "utf-8");
    const parsed = JSON.parse(raw) as { entries?: Array<unknown> };
    return parsed.entries?.length ?? 0;
  } catch (e) {
    console.warn(`[DB] cannot read drizzle _journal.json: ${(e as Error).message}`);
    return 0;
  }
}

/**
 * 用独立 readonly 连接读 `__drizzle_migrations` 行数，避免与 `getDb()` cache 的
 * 写连接共享 statement 缓存或事务可见性问题。
 */
export function readAppliedMigrationCount(): number {
  const dbPath = join(config.dataDir, "db", "core.sqlite");
  if (!existsSync(dbPath)) return 0;
  const sqlite = new Database(dbPath, { readonly: true });
  try {
    const row = sqlite
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM __drizzle_migrations")
      .get();
    return row?.c ?? 0;
  } catch (e) {
    // 表还没建（极早期 / 全新 datadir）：当作 0
    console.warn(`[DB] cannot read __drizzle_migrations: ${(e as Error).message}`);
    return 0;
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  await runMigrations();
}
