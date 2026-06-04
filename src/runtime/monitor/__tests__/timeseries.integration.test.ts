/**
 * timeseries 集成测试 —— 起 fresh sqlite，跑全量 migration，
 * 写入若干 llm_call_log / mcp_call_log / tool_call_log 行，
 * 验证 strftime 分桶 + groupBy + sessionId 过滤在真 SQLite 上能跑通。
 *
 * 与 timeseries.test.ts 的纯函数单测互补：那个测 bucketize 算法，
 * 这个测 SQL 端 strftime 实际语义 + 字段 wiring 是否正确。
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-ts-int-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const { queryTimeseries } = await import("../timeseries");

const WORKSPACE_ID = "ws-ts-int";
const PROJECT_ID = "proj-ts-int";
const SESSION_ID = "sess-ts-int";
const OTHER_SESSION_ID = "sess-other";
const WORKFLOW_ID = "wf-ts-int";
const OTHER_WORKFLOW_ID = "wf-other";
const SANDBOX_ID = "sb-ts-int";
const DEF_ID_A = "def-analyst-a";
const DEF_ID_B = "def-analyst-b";

describe("queryTimeseries · 集成", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();

    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "ts-int-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "ts-int-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.chatSession)
      .values([
        { id: SESSION_ID, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, title: "s1" },
        { id: OTHER_SESSION_ID, workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, title: "s2" },
      ])
      .onConflictDoNothing();
    await db
      .insert(schema.workflowRun)
      .values([
        {
          id: WORKFLOW_ID,
          projectId: PROJECT_ID,
          sessionId: SESSION_ID,
          goal: "g1",
          mode: "research",
          status: "completed",
        },
        {
          id: OTHER_WORKFLOW_ID,
          projectId: PROJECT_ID,
          sessionId: OTHER_SESSION_ID,
          goal: "g2",
          mode: "research",
          status: "completed",
        },
      ])
      .onConflictDoNothing();
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: SANDBOX_ID, name: "ts-int-sb", description: "" })
      .onConflictDoNothing();
    await db
      .insert(schema.agentDefinition)
      .values([
        {
          id: DEF_ID_A,
          role: "analyst_fundamental",
          name: "AnalystA",
          version: "v1",
          systemPrompt: "",
          toolsJson: [],
          mcpServersJson: [],
          skillsJson: [],
          subscriptionsJson: [],
          llmProvider: "mock",
          maxIterations: 6,
          sandboxPolicyId: SANDBOX_ID,
          enabled: true,
        },
        {
          id: DEF_ID_B,
          role: "analyst_macro",
          name: "AnalystB",
          version: "v1",
          systemPrompt: "",
          toolsJson: [],
          mcpServersJson: [],
          skillsJson: [],
          subscriptionsJson: [],
          llmProvider: "mock",
          maxIterations: 6,
          sandboxPolicyId: SANDBOX_ID,
          enabled: true,
        },
      ])
      .onConflictDoNothing();

    /**
     * 写 6 条 llm_call_log，分布在 3 个 1h 桶内：
     *   - 10:05 / 10:55     → openai / openai     (200, 300 tokens) → 桶 10:00 = 500
     *   - 11:30             → anthropic           (1000 tokens)      → 桶 11:00 = 1000
     *   - 12:00 / 12:45     → openai / anthropic  (50, 80 tokens)    → 桶 12:00: openai=50, anthropic=80
     *   - 14:00（其他 session）→ openai           (9999 tokens)      → 不应被 SESSION_ID 过滤命中
     */
    const baseHour = new Date("2026-05-26T10:00:00Z").getTime();
    const at = (hourOffset: number, minuteOffset = 0): string =>
      new Date(baseHour + hourOffset * 3_600_000 + minuteOffset * 60_000).toISOString();

    await db.insert(schema.llmCallLog).values([
      {
        id: "llm-1",
        workflowRunId: WORKFLOW_ID,
        agentStepId: null,
        agentDefinitionId: DEF_ID_A,
        provider: "openai",
        model: "gpt-4",
        totalTokens: 200,
        latencyMs: 100,
        status: "success",
        createdAt: at(0, 5),
      },
      {
        id: "llm-2",
        workflowRunId: WORKFLOW_ID,
        agentStepId: null,
        agentDefinitionId: DEF_ID_A,
        provider: "openai",
        model: "gpt-4",
        totalTokens: 300,
        latencyMs: 120,
        status: "success",
        createdAt: at(0, 55),
      },
      {
        id: "llm-3",
        workflowRunId: WORKFLOW_ID,
        agentStepId: null,
        agentDefinitionId: DEF_ID_B,
        provider: "anthropic",
        model: "claude-3",
        totalTokens: 1000,
        latencyMs: 150,
        status: "success",
        createdAt: at(1, 30),
      },
      {
        id: "llm-4",
        workflowRunId: WORKFLOW_ID,
        agentStepId: null,
        agentDefinitionId: DEF_ID_A,
        provider: "openai",
        model: "gpt-4",
        totalTokens: 50,
        latencyMs: 80,
        status: "error",
        errorMessage: "rate limited",
        createdAt: at(2, 0),
      },
      {
        id: "llm-5",
        workflowRunId: WORKFLOW_ID,
        agentStepId: null,
        agentDefinitionId: DEF_ID_B,
        provider: "anthropic",
        model: "claude-3",
        totalTokens: 80,
        latencyMs: 90,
        status: "fallback",
        createdAt: at(2, 45),
      },
      {
        id: "llm-other-session",
        workflowRunId: OTHER_WORKFLOW_ID,
        agentStepId: null,
        agentDefinitionId: DEF_ID_A,
        provider: "openai",
        model: "gpt-4",
        totalTokens: 9999,
        latencyMs: 200,
        status: "success",
        createdAt: at(4, 0),
      },
    ]);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("tokens metric · 按 provider 分组 · 1h 桶 · 验证 strftime 分桶语义", async () => {
    const res = await queryTimeseries({
      source: "llm_call_log",
      metric: "tokens",
      interval: "1h",
      from: "2026-05-26T10:00:00Z",
      to: "2026-05-26T13:00:00Z",
      groupBy: "provider",
    });

    expect(res.interval).toBe("1h");
    expect(res.buckets).toEqual([
      "2026-05-26T10:00:00Z",
      "2026-05-26T11:00:00Z",
      "2026-05-26T12:00:00Z",
    ]);
    const byName = new Map(res.series.map((s) => [s.name, s.points]));
    expect(byName.get("openai")).toEqual([500, 0, 50]);
    expect(byName.get("anthropic")).toEqual([0, 1000, 80]);
  });

  test("sessionId 过滤 · 其他 session 的数据不应被计入", async () => {
    const res = await queryTimeseries({
      source: "llm_call_log",
      metric: "tokens",
      interval: "1h",
      from: "2026-05-26T10:00:00Z",
      to: "2026-05-26T15:00:00Z",
      sessionId: SESSION_ID,
    });
    /** 总 tokens = 500 + 1000 + 50 + 80 = 1630，绝不包含 OTHER_SESSION 的 9999 */
    const total = (res.series[0]?.points ?? []).reduce((a, b) => a + b, 0);
    expect(total).toBe(1630);
  });

  test("errorCount · llm fallback 计成功，error/timeout 才算错", async () => {
    const res = await queryTimeseries({
      source: "llm_call_log",
      metric: "errorCount",
      interval: "1h",
      from: "2026-05-26T10:00:00Z",
      to: "2026-05-26T13:00:00Z",
    });
    /** 上面 llm-4 一条 error → 1；llm-5 是 fallback → 不算错；其他 success */
    const total = (res.series[0]?.points ?? []).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  test("groupBy=agentDefinitionId · 直接走冗余列，不依赖 join", async () => {
    const res = await queryTimeseries({
      source: "llm_call_log",
      metric: "count",
      interval: "1d",
      from: "2026-05-26T00:00:00Z",
      to: "2026-05-27T00:00:00Z",
      groupBy: "agentDefinitionId",
    });
    const byDef = new Map(res.series.map((s) => [s.name, s.points]));
    /** def-A: llm-1/2/4/other-session(同日)= 4 条；def-B: llm-3/5 = 2 条 */
    expect(byDef.get(DEF_ID_A)?.[0]).toBe(4);
    expect(byDef.get(DEF_ID_B)?.[0]).toBe(2);
  });

  test("不支持的 source/metric 组合（tool_call_log + tokens）→ 抛错", async () => {
    await expect(
      queryTimeseries({
        source: "tool_call_log",
        metric: "tokens",
        interval: "1h",
        from: "2026-05-26T10:00:00Z",
        to: "2026-05-26T11:00:00Z",
      })
    ).rejects.toThrow(/not supported/i);
  });

  test("桶过多 → 直接拒绝（防 OOM）", async () => {
    await expect(
      queryTimeseries({
        source: "llm_call_log",
        metric: "count",
        interval: "1m",
        from: "2026-05-01T00:00:00Z",
        to: "2026-05-30T00:00:00Z", // 30 天 × 1440 桶 = 43200 > 1000
      })
    ).rejects.toThrow(/too many buckets/i);
  });
});
