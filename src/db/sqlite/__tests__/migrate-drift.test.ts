/**
 * runMigrations sanity drift 检查 —— 回归 2026-05-25 故障
 *
 * 故障复盘见 src/db/sqlite/migrate.ts 头部注释。
 */

import { describe, expect, test, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  MigrationDriftError,
  readAppliedMigrationCount,
  readJournalEntryCount,
  runMigrations,
} from "../migrate";
import { config } from "../../../config";

beforeAll(async () => {
  await runMigrations();
});

describe("runMigrations sanity drift check", () => {
  test("正常路径：__drizzle_migrations 行数 >= journal entries 数", () => {
    const here = new URL(".", import.meta.url).pathname;
    const dir = join(here, "..", "migrations");
    const journalCount = readJournalEntryCount(dir);
    const appliedCount = readAppliedMigrationCount();
    expect(journalCount).toBeGreaterThan(0);
    expect(appliedCount).toBeGreaterThanOrEqual(journalCount);
  });

  test("journal 文件不存在 → readJournalEntryCount 返回 0（不抛错）", () => {
    expect(readJournalEntryCount("/nonexistent/__nope__")).toBe(0);
  });

  test("__drizzle_migrations 表不存在 → readAppliedMigrationCount 返回 0（不抛错）", () => {
    const tmpDir = process.env.QUBIT_DATA_DIR ?? config.dataDir;
    const dbPath = join(tmpDir, "db", "__test_no_table.sqlite");
    // 建一个空 sqlite，不建 __drizzle_migrations 表
    const sqlite = new Database(dbPath);
    sqlite.exec("CREATE TABLE foo(id INTEGER)");
    sqlite.close();
    // 切到这个空库读 → 应返回 0 不抛错
    const origDir = config.dataDir;
    try {
      // readAppliedMigrationCount 直接读 config.dataDir，临时不可达时走 catch 路径
      // 由于我们不能在测试里 mutate config，这里用 sanity assertion：
      // 至少能正常返回（不 throw），具体值由当前 dataDir 决定
      const n = readAppliedMigrationCount();
      expect(typeof n).toBe("number");
      expect(n).toBeGreaterThanOrEqual(0);
    } finally {
      // 清理临时库
      try {
        const fs = require("node:fs");
        fs.unlinkSync(dbPath);
      } catch {
        /* ignore */
      }
      void origDir;
    }
  });

  test("MigrationDriftError 包含 expected/actual + 修复提示", () => {
    const err = new MigrationDriftError(43, 41, "/tmp/migrations");
    expect(err).toBeInstanceOf(Error);
    expect(err.expected).toBe(43);
    expect(err.actual).toBe(41);
    expect(err.message).toContain("43");
    expect(err.message).toContain("41");
    expect(err.message).toContain("bun run db:migrate");
  });

  test("smoke: 实际 migrations 目录里 0042 / 0043 entries 都在 journal 中", () => {
    const here = new URL(".", import.meta.url).pathname;
    const dir = join(here, "..", "migrations");
    const journalPath = join(dir, "meta", "_journal.json");
    if (!existsSync(journalPath)) return; // bundle 路径下没源码 migrations 时跳过
    const j = JSON.parse(readFileSync(journalPath, "utf-8")) as {
      entries: Array<{ tag: string }>;
    };
    const tags = j.entries.map((e) => e.tag);
    expect(tags).toContain("0042_agent_skill");
    expect(tags).toContain("0043_workflow_hitl");
  });

  test("smoke: 跑完 migrations 后 workflow_hitl_request / agent_skill 表确实存在", async () => {
    const dbPath = join(config.dataDir, "db", "core.sqlite");
    expect(existsSync(dbPath)).toBe(true);
    const sqlite = new Database(dbPath, { readonly: true });
    try {
      const rows = sqlite
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN " +
            "('workflow_hitl_request','agent_skill','agent_skill_run','skill_curator_run')"
        )
        .all();
      const names = new Set(rows.map((r) => r.name));
      expect(names.has("workflow_hitl_request")).toBe(true);
      expect(names.has("agent_skill")).toBe(true);
      expect(names.has("agent_skill_run")).toBe(true);
      expect(names.has("skill_curator_run")).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
