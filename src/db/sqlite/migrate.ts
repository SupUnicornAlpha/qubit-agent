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

/**
 * 选择 migrations 目录。两个候选：
 *   1. `getBundledMigrationsDir()` = `$QUBIT_APP_ROOT/db/migrations`（Tauri sidecar 注入）
 *   2. 源码旁 `src/db/sqlite/migrations`（dev 模式下永远是最新的）
 *
 * 规则：如果两边都存在，**取 `_journal.json` entries 更多的那个**，避免 Tauri debug
 * build 把 `QUBIT_APP_ROOT` 指向陈旧 bundle 时，新 .sql 文件被吞掉（2026-05-25 故障的
 * 直接成因之一）。
 */
function migrationsDir(): string {
  const bundled = getBundledMigrationsDir();
  const here = dirname(fileURLToPath(import.meta.url));
  const source = join(here, "migrations");

  const bundledExists = existsSync(bundled);
  const sourceExists = existsSync(source);

  if (bundledExists && sourceExists) {
    const bundledCount = readJournalEntryCount(bundled);
    const sourceCount = readJournalEntryCount(source);
    if (sourceCount > bundledCount) {
      console.log(
        `[DB] dev override: using source migrations (${sourceCount} entries) instead of stale bundled (${bundledCount}) at ${bundled}`
      );
      return source;
    }
    return bundled;
  }
  if (bundledExists) return bundled;
  return source;
}

export type MigrationDriftDirection = "missing" | "ahead";

export class MigrationDriftError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
    public readonly migrationsDir: string,
    public readonly direction: MigrationDriftDirection
  ) {
    const base =
      direction === "missing"
        ? `_journal.json has ${expected} entries but __drizzle_migrations only ${actual} rows. ` +
          `DDL 未真正 apply（drizzle.migrate 可能被静默跳过）。`
        : `__drizzle_migrations has ${actual} rows but bundled _journal.json only ${expected} entries. ` +
          `典型成因：Tauri sidecar bundle 比当前数据库老 —— 需重新构建 bundle 或回滚 DB。`;
    super(
      `migration_drift[${direction}]: ${base} ` +
        `journal=${migrationsDir}/meta/_journal.json；` +
        `修复（缺 migration）：QUBIT_DATA_DIR=... bun run db:migrate；` +
        `修复（bundle 落后）：重新构建 Tauri sidecar 或临时用 \`bun run dev\` 跑源码 backend。`
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
  if (expected > 0 && actual !== expected) {
    const direction: MigrationDriftDirection = actual < expected ? "missing" : "ahead";
    throw new MigrationDriftError(expected, actual, dir, direction);
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
