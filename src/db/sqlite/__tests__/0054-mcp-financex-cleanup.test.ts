/**
 * Migration 0054 回归测试。
 *
 * 验证两件事：
 *   1. agent_definition.system_prompt 里的 mcp-financex 引用被五条 REPLACE 干净清除
 *   2. analyst_signal 里旧 hold@0.4 兜底行被打上 parseFailed 标记，新行不受影响
 *
 * 实现策略：
 *   - 起一个 fresh DB（QUBIT_DATA_DIR=/tmp 隔离），一次性跑完所有 migration（含 0054）
 *   - 因为 0054 是 in-place UPDATE 且**幂等**，所以"种入测试数据后再跑一遍 0054"
 *     行为与"先跑 → 再种 → 再跑"等价，断言看终态即可
 *   - 用 sqlite.exec 重跑 0054 SQL 文件实现"在 0053 应用之后插入测试数据再跑 0054"
 *     的语义
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-mig-0054-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../migrate");
const { getDb, getSqliteForTesting, closeDb } = await import("../client");
const schema = await import("../schema");
const drizzle = await import("drizzle-orm");

const MIGRATION_FILE = join(
  __dirname,
  "..",
  "migrations",
  "0054_cleanup_dangling_mcp_and_stale_signals.sql"
);

const SAMPLE_PROMPTS: Array<{ id: string; before: string; after: string }> = [
  {
    id: "def-fundamental",
    before: "调 MCP（如 fsi-factset / mathjs / mcp-financex）做精确计算，结果回写。",
    after: "调 MCP（如 fsi-factset / mathjs）做精确计算，结果回写。",
  },
  {
    id: "def-orchestrator",
    before: "**机构数据/复杂计算** → call_mcp（mathjs、mcp-financex；若已配置 fsi-factset 等）",
    after: "**机构数据/复杂计算** → call_mcp（mathjs；若已配置 fsi-factset 等）",
  },
  {
    id: "def-market-data",
    before: "可 call_mcp 补充 mcp-financex 等。",
    after: "可 call_mcp 补充 已注册启用的 MCP server。",
  },
  {
    id: "def-clean",
    /** 已经干净的 prompt 不应被 migration 触碰 */
    before: "使用 fsi-factset 做精确计算，结果回写。",
    after: "使用 fsi-factset 做精确计算，结果回写。",
  },
  {
    id: "def-orphan-mcp-financex",
    /** 兜底：孤零零 mcp-financex 提及（旧示例代码段） */
    before: '示例：`{"serverName":"mcp-financex"}`',
    after: '示例：`{"serverName":"已注册启用的 MCP server"}`',
  },
];

describe("migration 0054 in-place cleanup", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();

    /**
     * 0054 已经在 runMigrations() 跑过一次（DB 是空的，没数据可改）。
     * 这里我们种入"看起来像旧脏数据"的样本，再用 sqlite.exec 重跑 0054 的
     * SQL 文件 —— 这样能复现真实场景：DB 里已有脏数据时 migration 行为正确。
     *
     * agent_definition.sandbox_policy_id 是 NOT NULL（schema 0000+）；先种一条
     * sandbox_policy 给所有测试 def 共用。
     */
    const SANDBOX_ID = "sb-mig-0054";
    await db
      .insert(schema.sandboxPolicy)
      .values({
        id: SANDBOX_ID,
        name: "mig-0054-sb",
        description: "migration 0054 test sandbox",
      })
      .onConflictDoNothing();

    for (const p of SAMPLE_PROMPTS) {
      await db
        .insert(schema.agentDefinition)
        .values({
          id: p.id,
          role: "analyst_fundamental",
          name: `mig-test-${p.id}`,
          version: "v1",
          systemPrompt: p.before,
          toolsJson: [],
          mcpServersJson: [],
          skillsJson: [],
          subscriptionsJson: ["TASK_ASSIGN"],
          llmProvider: "mock",
          maxIterations: 6,
          sandboxPolicyId: SANDBOX_ID,
          enabled: true,
        })
        .onConflictDoNothing();
    }

    /**
     * 历史 hold@0.4 塌缩 signal 的样本：
     *   - sig-stale-1：典型脏数据（应被打上 parseFailed=true）
     *   - sig-real-04：confidence 真的就是 0.4 但 reasoning 没有 rawResponse → 不动
     *   - sig-already-marked：已经标过 parseFailed，重跑应幂等
     *   - sig-real-buy：confidence=0.4 但 signal=buy → 不动
     */
    const WORKSPACE_ID = "ws-mig-0054";
    const PROJECT_ID = "proj-mig-0054";
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "mig-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "mig-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.workflowRun)
      .values({
        id: "wf-mig-0054",
        projectId: PROJECT_ID,
        goal: "mig test",
        mode: "research",
        status: "completed",
      })
      .onConflictDoNothing();

    await db
      .insert(schema.analystSignal)
      .values([
        {
          id: "sig-stale-1",
          workflowRunId: "wf-mig-0054",
          analystRole: "analyst_fundamental",
          ticker: "AAPL",
          signal: "hold",
          confidence: 0.4,
          reasoning: "（模型未输出 JSON）",
          dataSnapshotJson: { rawResponse: "<bad LLM output>" },
        },
        {
          id: "sig-real-04",
          workflowRunId: "wf-mig-0054",
          analystRole: "analyst_macro",
          ticker: "MSFT",
          signal: "hold",
          confidence: 0.4,
          reasoning: "宏观数据中性",
          dataSnapshotJson: { source: "macro_indicator" },
        },
        {
          id: "sig-already-marked",
          workflowRunId: "wf-mig-0054",
          analystRole: "analyst_technical",
          ticker: "NVDA",
          signal: "hold",
          confidence: 0.4,
          reasoning: "（模型未输出 JSON）",
          dataSnapshotJson: {
            rawResponse: "<bad>",
            parseFailed: true,
            parseFailedAt: "2026-05-25",
          },
        },
        {
          id: "sig-real-buy",
          workflowRunId: "wf-mig-0054",
          analystRole: "analyst_sentiment",
          ticker: "TSLA",
          signal: "buy",
          confidence: 0.4,
          reasoning: "情绪偏多但仓位克制",
          dataSnapshotJson: { rawResponse: "valid LLM out" },
        },
      ])
      .onConflictDoNothing();

    /** 直接 sqlite.exec 跑 0054 SQL（已经在 runMigrations 跑过，重跑仍幂等） */
    const sql = readFileSync(MIGRATION_FILE, "utf-8");
    const sqlite = getSqliteForTesting();
    sqlite.exec(sql);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("已命中样本被改成预期形态", async () => {
    const db = await getDb();
    for (const p of SAMPLE_PROMPTS) {
      const rows = await db
        .select({ sp: schema.agentDefinition.systemPrompt })
        .from(schema.agentDefinition)
        .where(drizzle.eq(schema.agentDefinition.id, p.id))
        .limit(1);
      expect(rows[0]?.sp).toBe(p.after);
    }
  });

  test("system_prompt 全表已无 mcp-financex 残留", () => {
    const sqlite = getSqliteForTesting();
    const cnt = sqlite
      .prepare(
        "SELECT COUNT(*) AS c FROM agent_definition WHERE system_prompt LIKE '%mcp-financex%'"
      )
      .get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  test("hold@0.4 + rawResponse 行被标 parseFailed", () => {
    const sqlite = getSqliteForTesting();
    const row = sqlite
      .prepare(
        "SELECT json_extract(data_snapshot_json, '$.parseFailed') AS pf, " +
          "json_extract(data_snapshot_json, '$.parseFailedAt') AS pat " +
          "FROM analyst_signal WHERE id = 'sig-stale-1'"
      )
      .get() as { pf: number | string | null; pat: string | null };
    /**
     * sqlite json_extract 把 JSON true 解析成整数 1（json1 行为，跟 PG 不同）。
     */
    expect(row.pf).toBe(1);
    expect(row.pat).toBe("2026-05-27");
  });

  test("已经标过的行不会被重写（幂等）", () => {
    const sqlite = getSqliteForTesting();
    const row = sqlite
      .prepare(
        "SELECT json_extract(data_snapshot_json, '$.parseFailedAt') AS pat " +
          "FROM analyst_signal WHERE id = 'sig-already-marked'"
      )
      .get() as { pat: string };
    /** 应保留旧的 2026-05-25 而不是被覆盖成 2026-05-27 */
    expect(row.pat).toBe("2026-05-25");
  });

  test("非塌缩样本（hold@0.4 但没 rawResponse / signal=buy）保持不动", () => {
    const sqlite = getSqliteForTesting();
    const realHold = sqlite
      .prepare(
        "SELECT json_extract(data_snapshot_json, '$.parseFailed') AS pf " +
          "FROM analyst_signal WHERE id = 'sig-real-04'"
      )
      .get() as { pf: number | null };
    expect(realHold.pf).toBeNull();

    const realBuy = sqlite
      .prepare(
        "SELECT json_extract(data_snapshot_json, '$.parseFailed') AS pf " +
          "FROM analyst_signal WHERE id = 'sig-real-buy'"
      )
      .get() as { pf: number | null };
    /** signal=buy 不在 WHERE 命中范围，不应被标 */
    expect(realBuy.pf).toBeNull();
  });
});
