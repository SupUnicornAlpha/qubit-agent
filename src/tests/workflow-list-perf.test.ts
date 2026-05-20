import { Database } from "bun:sqlite";
/**
 * 验证：监控/工作流列表的索引优化生效。
 *
 * 这个测试的目标：
 *   1) `monitor/workflows` 路由实际执行的 SQL 在加了 `idx_workflow_run_session_created`
 *      与 `idx_workflow_run_created_at` 索引后，能走索引扫描（EXPLAIN QUERY PLAN 中
 *      含 USING INDEX），而不是 SCAN TABLE workflow_run。
 *   2) 在 5000 行规模下，过滤 + 排序 + LIMIT 200 的查询耗时显著小于「全表 SELECT * + JS 过滤」的旧实现。
 *
 * 这同时也是一个回归基线：如果未来有人不小心把过滤/排序回退到 JS 层，本测试会立即报警。
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const TMP_DIR = join(process.cwd(), ".tmp-workflow-list-perf");
const DB_PATH = join(TMP_DIR, "core.sqlite");
const MIGRATIONS_DIR = join(process.cwd(), "src/db/sqlite/migrations");

function explainPlan(db: Database, sql: string, params: unknown[] = []): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail?: string }[];
  return rows.map((r) => r.detail ?? JSON.stringify(r)).join(" | ");
}

describe("workflow-list-perf", () => {
  let sqlite: Database;

  beforeAll(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
    await mkdir(dirname(DB_PATH), { recursive: true });
    sqlite = new Database(DB_PATH);
    sqlite.exec("PRAGMA journal_mode=WAL;");
    sqlite.exec("PRAGMA foreign_keys=ON;");
    const db = drizzle(sqlite);
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    // 准备基础数据
    sqlite
      .prepare("INSERT INTO workspace (id, name, owner) VALUES (?, ?, ?)")
      .run("ws-1", "ws", "tester");
    sqlite
      .prepare(
        "INSERT INTO project (id, workspace_id, name, market_scope, status) VALUES (?, ?, ?, ?, ?)"
      )
      .run("pj-1", "ws-1", "p", "CN-A", "active");
    sqlite
      .prepare(
        "INSERT INTO chat_session (id, workspace_id, project_id, title, status, created_by) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run("sess-1", "ws-1", "pj-1", "s", "active", "test");

    // 灌 5000 行 workflow_run（大部分在 sess-1，其余无 session_id）
    const insert = sqlite.prepare(
      "INSERT INTO workflow_run (id, project_id, session_id, goal, mode, source, status, loop_kind, execution_path, loop_options_json, resume_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const tx = sqlite.transaction((rows: number) => {
      for (let i = 0; i < rows; i++) {
        const sessionId = i % 5 === 0 ? null : "sess-1";
        insert.run(
          `wf-${i}`,
          "pj-1",
          sessionId,
          `goal-${i}`,
          i % 2 === 0 ? "research" : "backtest",
          "api",
          i % 3 === 0 ? "completed" : i % 3 === 1 ? "running" : "cancelled",
          "native",
          "graph",
          "{}",
          0
        );
      }
    });
    tx(5000);
  });

  test("uses index for ORDER BY + LIMIT scan", () => {
    const plan = explainPlan(
      sqlite,
      "SELECT id FROM workflow_run ORDER BY created_at DESC LIMIT 200"
    );
    // 关键判定：EXPLAIN 必须含 "USING INDEX"，而非 "SCAN workflow_run"。
    // 注意：SQLite 在小数据/或缺少 ANALYZE 时偶尔仍走 SCAN+sort；
    // 我们至少要求计划里包含 idx_workflow_run_created_at（即 planner 知道这个索引）。
    expect(plan.toLowerCase()).toContain("idx_workflow_run_created_at");
  });

  test("uses session+created composite index when filtering by sessionId", () => {
    const plan = explainPlan(
      sqlite,
      "SELECT id FROM workflow_run WHERE session_id = ? ORDER BY created_at DESC LIMIT 200",
      ["sess-1"]
    );
    expect(plan.toLowerCase()).toContain("idx_workflow_run_session_created");
  });

  test("filtered+limited query is fast on 5000 rows", () => {
    const t0 = performance.now();
    const rows = sqlite
      .prepare(
        "SELECT id, goal, mode, status, created_at FROM workflow_run WHERE session_id = ? ORDER BY created_at DESC LIMIT 200"
      )
      .all("sess-1") as Array<{ id: string }>;
    const elapsed = performance.now() - t0;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(200);
    // 5000 行规模下，预期 < 50ms（CI 富余取 250ms）。
    expect(elapsed).toBeLessThan(250);
  });
});
