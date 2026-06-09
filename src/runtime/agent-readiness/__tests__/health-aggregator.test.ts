/**
 * Health aggregator unit tests.
 *
 * 覆盖 5 个维度的聚合 + 健康度评级 + 错误归一化。用内存 DB 自建简版 schema
 * （只建本聚合器读到的 5 列），避免拉真实 schema.ts 的 100+ 表。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { aggregateHealth, normalizeErrorMessage } from "../health-aggregator";

let sqlite: Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE tool_call_log (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT,
      tool_name TEXT NOT NULL,
      tool_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      error_message TEXT
    );
    CREATE TABLE mcp_call_log (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT,
      server_name TEXT NOT NULL,
      status TEXT NOT NULL,
      circuit_state TEXT,
      transport TEXT,
      latency_ms INTEGER,
      error_code TEXT
    );
    CREATE TABLE llm_call_log (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      finish_reason TEXT,
      cost_usd REAL,
      error_message TEXT
    );
    CREATE TABLE skill_recall_log (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT,
      skill_id TEXT NOT NULL,
      score REAL,
      executed INTEGER NOT NULL DEFAULT 0
    );
  `);
});

afterEach(() => {
  sqlite.close();
});

function insertTool(
  row: Partial<{
    id: string;
    workflowRunId: string;
    toolName: string;
    toolKind: string;
    status: string;
    latencyMs: number;
    errorMessage: string;
  }> = {}
) {
  sqlite
    .prepare(
      `INSERT INTO tool_call_log (id, workflow_run_id, tool_name, tool_kind, status, latency_ms, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id ?? crypto.randomUUID(),
      row.workflowRunId ?? "wf-1",
      row.toolName ?? "factor.register",
      row.toolKind ?? "builtin",
      row.status ?? "success",
      row.latencyMs ?? 50,
      row.errorMessage ?? null
    );
}

function insertMcp(row: Partial<{
  id: string;
  workflowRunId: string;
  serverName: string;
  status: string;
  circuitState: string | null;
  transport: string | null;
  latencyMs: number;
  errorCode: string | null;
}> = {}) {
  sqlite
    .prepare(
      `INSERT INTO mcp_call_log (id, workflow_run_id, server_name, status, circuit_state, transport, latency_ms, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id ?? crypto.randomUUID(),
      row.workflowRunId ?? "wf-1",
      row.serverName ?? "plugin-datadog",
      row.status ?? "success",
      row.circuitState ?? null,
      row.transport ?? "stdio",
      row.latencyMs ?? 100,
      row.errorCode ?? null
    );
}

function insertLlm(row: Partial<{
  id: string;
  workflowRunId: string;
  provider: string;
  model: string;
  status: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  finishReason: string | null;
  costUsd: number;
  errorMessage: string | null;
}> = {}) {
  sqlite
    .prepare(
      `INSERT INTO llm_call_log (id, workflow_run_id, provider, model, status, prompt_tokens, completion_tokens, total_tokens, finish_reason, cost_usd, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.id ?? crypto.randomUUID(),
      row.workflowRunId ?? "wf-1",
      row.provider ?? "openai",
      row.model ?? "gpt-4o",
      row.status ?? "success",
      row.promptTokens ?? 1000,
      row.completionTokens ?? 500,
      row.totalTokens ?? 1500,
      row.finishReason ?? "stop",
      row.costUsd ?? 0.01,
      row.errorMessage ?? null
    );
}

function insertSkill(row: Partial<{
  id: string;
  workflowRunId: string;
  skillId: string;
  score: number;
  executed: number;
}> = {}) {
  sqlite
    .prepare(
      `INSERT INTO skill_recall_log (id, workflow_run_id, skill_id, score, executed)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      row.id ?? crypto.randomUUID(),
      row.workflowRunId ?? "wf-1",
      row.skillId ?? "skill-a",
      row.score ?? 0.8,
      row.executed ?? 0
    );
}

describe("aggregateHealth", () => {
  test("空 workflowRunIds 数组应直接抛错（防御性，不允许全库扫）", () => {
    expect(() => aggregateHealth(sqlite, [])).toThrow(/non-empty/);
  });

  test("Tool: 全 success → green，sandbox_blocked 出现 → red", () => {
    for (let i = 0; i < 10; i++) insertTool({ toolName: "factor.register" });
    insertTool({ toolName: "strategy.create_version", status: "sandbox_blocked" });
    const r = aggregateHealth(sqlite, ["wf-1"]);
    const factor = r.tools.find((t) => t.toolName === "factor.register");
    const strategy = r.tools.find((t) => t.toolName === "strategy.create_version");
    expect(factor?.healthGrade).toBe("green");
    expect(factor?.successRate).toBe(1);
    expect(strategy?.healthGrade).toBe("red");
    expect(strategy?.sandboxBlockedCount).toBe(1);
    expect(r.summary.redToolCount).toBe(1);
  });

  test("Tool: 成功率 < 90% 触发 red，错误聚合 top error 出现", () => {
    for (let i = 0; i < 8; i++) {
      insertTool({ toolName: "fetch_news", status: "error", errorMessage: "rate limited (after 3 retries)" });
    }
    for (let i = 0; i < 2; i++) insertTool({ toolName: "fetch_news" });
    const r = aggregateHealth(sqlite, ["wf-1"]);
    const t = r.tools.find((x) => x.toolName === "fetch_news");
    expect(t?.healthGrade).toBe("red");
    expect(t?.successRate).toBe(0.2);
    expect(t?.topErrors[0]?.message).toContain("rate limited");
    expect(t?.topErrors[0]?.count).toBe(8);
  });

  test("MCP: circuit_state=open 出现 → red", () => {
    for (let i = 0; i < 10; i++) insertMcp({ serverName: "plugin-datadog" });
    insertMcp({ serverName: "plugin-datadog", status: "failed", circuitState: "open", errorCode: "circuit_open" });
    const r = aggregateHealth(sqlite, ["wf-1"]);
    const m = r.mcp.find((x) => x.serverName === "plugin-datadog");
    expect(m?.circuitOpenCount).toBe(1);
    expect(m?.healthGrade).toBe("red");
  });

  test("MCP: failed/timeout 比例 5%-15% 触发 yellow", () => {
    for (let i = 0; i < 17; i++) insertMcp({ serverName: "plugin-figma" });
    insertMcp({ serverName: "plugin-figma", status: "timeout", errorCode: "timeout_ms" });
    insertMcp({ serverName: "plugin-figma", status: "timeout", errorCode: "timeout_ms" });
    const r = aggregateHealth(sqlite, ["wf-1"]);
    const m = r.mcp.find((x) => x.serverName === "plugin-figma");
    // 2/19 ≈ 10.5%
    expect(m?.healthGrade).toBe("yellow");
  });

  test("LLM: 多 provider/model 分组汇总 + 截断率 + cost", () => {
    insertLlm({ provider: "openai", model: "gpt-4o", promptTokens: 1000, completionTokens: 500, totalTokens: 1500, costUsd: 0.02 });
    insertLlm({ provider: "openai", model: "gpt-4o", promptTokens: 2000, completionTokens: 800, totalTokens: 2800, costUsd: 0.04, finishReason: "length" });
    insertLlm({ provider: "anthropic", model: "claude-3-5-sonnet", promptTokens: 1500, completionTokens: 1000, totalTokens: 2500, costUsd: 0.03 });
    const r = aggregateHealth(sqlite, ["wf-1"]);
    const oa = r.llm.find((l) => l.provider === "openai");
    const an = r.llm.find((l) => l.provider === "anthropic");
    expect(oa?.totalCalls).toBe(2);
    expect(oa?.totalTokens).toBe(4300);
    expect(oa?.truncationCount).toBe(1);
    expect(oa?.truncationRate).toBe(0.5);
    expect(oa?.totalCostUsd).toBeCloseTo(0.06, 6);
    expect(an?.totalCalls).toBe(1);
    expect(r.summary.totalCostUsd).toBeCloseTo(0.09, 6);
  });

  test("Skill: 召回 + 执行率分组", () => {
    insertSkill({ skillId: "ta-analysis", score: 0.9, executed: 1 });
    insertSkill({ skillId: "ta-analysis", score: 0.8, executed: 0 });
    insertSkill({ skillId: "ta-analysis", score: 0.7, executed: 1 });
    insertSkill({ skillId: "report-gen", score: 0.6, executed: 0 });
    const r = aggregateHealth(sqlite, ["wf-1"]);
    const ta = r.skills.find((s) => s.skillId === "ta-analysis");
    expect(ta?.recallCount).toBe(3);
    expect(ta?.executedCount).toBe(2);
    expect(ta?.executedRate).toBeCloseTo(2 / 3, 4);
  });

  test("workflow_run_id 过滤：只统计指定的 workflow，不串其他 workflow 的数据", () => {
    insertTool({ workflowRunId: "wf-a", toolName: "factor.register" });
    insertTool({ workflowRunId: "wf-a", toolName: "factor.register" });
    insertTool({ workflowRunId: "wf-b", toolName: "factor.register" });
    insertTool({ workflowRunId: "wf-other", toolName: "factor.register" });
    const r = aggregateHealth(sqlite, ["wf-a", "wf-b"]);
    const t = r.tools.find((x) => x.toolName === "factor.register");
    expect(t?.totalCalls).toBe(3);
  });

  test("Errors 聚合：动态 token 归一化后能合并 + top 排序", () => {
    // 用 UUID + 时间戳模拟真实生产错误消息里的"动态部分"
    insertTool({
      toolName: "fetch_news",
      status: "error",
      errorMessage:
        "request 11111111-2222-3333-4444-555555555555 failed at 2026-06-08T10:30:00Z (rate limited)",
    });
    insertTool({
      toolName: "fetch_news",
      status: "error",
      errorMessage:
        "request aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee failed at 2026-06-08T11:30:00Z (rate limited)",
    });
    insertMcp({ serverName: "x", status: "failed", errorCode: "timeout_ms" });
    const r = aggregateHealth(sqlite, ["wf-1"]);
    expect(r.errors.length).toBeGreaterThan(0);
    const fetchErr = r.errors.find((e) => e.source === "tool");
    // 两条 fetch_news 错误归一化后 pattern 应一致并合并
    expect(fetchErr?.count).toBe(2);
    expect(fetchErr?.pattern).toContain("<UUID>");
    expect(fetchErr?.pattern).toContain("<TS>");
  });
});

describe("normalizeErrorMessage", () => {
  test("UUID / 时间戳 / 长 hash / 数字 都被替换为占位符", () => {
    const raw =
      "workflow abc12345-abcd-1234-5678-abcdef123456 failed at 2026-06-08T10:30:00.123Z (id=99999, hash=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6)";
    const norm = normalizeErrorMessage(raw);
    expect(norm).toContain("<UUID>");
    expect(norm).toContain("<TS>");
    expect(norm).toContain("<HASH>");
    expect(norm).toContain("<N>");
    expect(norm).not.toContain("abc12345-abcd");
  });

  test("两个动态消息（UUID + 时间戳 + 数字 id）归一化后相等", () => {
    // 实际生产里"动态部分"主要是 UUID / 时间戳 / 长 hash / 大数字（订单号、req id 等）
    const a = normalizeErrorMessage(
      "request 11111111-2222-3333-4444-555555555555 (id=99999) failed at 2026-06-08T10:00:00Z"
    );
    const b = normalizeErrorMessage(
      "request aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee (id=88888) failed at 2026-06-09T11:00:00Z"
    );
    expect(a).toBe(b);
  });
});
