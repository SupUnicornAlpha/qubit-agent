import { describe, expect, test } from "bun:test";
import { registerBuiltinConnectors } from "../../connectors/bootstrap";
import { connectorRegistry } from "../../connectors/registry";
import {
  dispatchBuiltinTool,
  isBuiltinTool,
  isRoutedTool,
  listRegisteredBuiltinTools,
} from "./builtin-tools";
import { buildToolCatalog } from "./tool-catalog";
import { resolveConnectorForTool } from "./tool-routes";

describe("tool routes", () => {
  test("connector routes for market and backtest tools", () => {
    expect(resolveConnectorForTool("fetch_klines")).toBe("qubit-data");
    expect(resolveConnectorForTool("run_backtest")).toBe("qubit-backtest");
    expect(resolveConnectorForTool("compute_factors")).toBe("qubit-research");
    expect(resolveConnectorForTool("evaluate_risk")).toBe("qubit-risk");
  });

  test("builtin tools are not double-routed", () => {
    expect(isRoutedTool("assign_task")).toBe(false);
    expect(isBuiltinTool("assign_task")).toBe(true);
    expect(isBuiltinTool("fetch_klines")).toBe(false);
    expect(isBuiltinTool("call_team_research")).toBe(true);
  });
});

const ctx = {
  workflowId: "wf-test",
  runId: "run-test",
  traceId: "trace-test",
  agentInstanceId: "inst-test",
  projectId: "proj-test",
  definition: {
    id: "def-test",
    role: "orchestrator" as const,
    name: "test",
    version: "1",
    systemPrompt: "",
    tools: ["assign_task"],
    mcpServers: [],
    skills: [],
    subscriptions: [],
    llmProvider: "mock",
    maxIterations: 5,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  reasonText: "分析 AAPL",
  inboundPayload: { goal: "分析 AAPL 趋势" },
};

describe("builtin tool handlers", () => {
  test("catalog includes builtin and connector entries", () => {
    const catalog = buildToolCatalog();
    expect(catalog.some((e) => e.name === "fetch_klines" && e.kind === "connector")).toBe(true);
    expect(catalog.some((e) => e.name === "run_analyst_team" && e.kind === "builtin")).toBe(true);
    expect(listRegisteredBuiltinTools().length).toBeGreaterThan(10);
  });

  test("4 deleted stubs are no longer registered as builtin handlers", () => {
    expect(isBuiltinTool("task_decompose")).toBe(false);
    expect(isBuiltinTool("analyze_industry")).toBe(false);
    expect(isBuiltinTool("analyze_policy")).toBe(false);
    expect(isBuiltinTool("get_analyst_ratings")).toBe(false);
  });
});

describe("factor.mine.llm builtin (P0-4)", () => {
  test("missing expressions → throws min_count error", async () => {
    const { randomUUID } = await import("node:crypto");
    const { runMigrations } = await import("../../db/sqlite/migrate");
    const { getDb } = await import("../../db/sqlite/client");
    const schema = await import("../../db/sqlite/schema");
    await runMigrations();
    const db = await getDb();
    const wid = randomUUID();
    const pid = randomUUID();
    await db.insert(schema.workspace).values({ id: wid, name: "p04-ws", owner: "t" });
    await db.insert(schema.project).values({
      id: pid,
      workspaceId: wid,
      name: "p04-proj",
      marketScope: "CN-A",
      status: "active",
    });

    const ctxLocal = { ...ctx, projectId: pid };
    await expect(
      dispatchBuiltinTool("factor.mine.llm", ctxLocal, {
        expressions: ["close"],
        symbols: ["SYN1"],
        start_date: "2026-01-01",
        end_date: "2026-04-30",
      })
    ).rejects.toThrow(/expressions\.length.*< min_count/);
  });

  test("symbols 缺失 → throws", async () => {
    await expect(
      dispatchBuiltinTool("factor.mine.llm", ctx, {
        expressions: ["a", "b", "c", "d", "e"],
        symbols: [],
        start_date: "2026-01-01",
        end_date: "2026-04-30",
      })
    ).rejects.toThrow(/symbols is required/);
  });

  test("happy path: 5 个表达式 → 评估闸门 → auto_promote draft 因子", async () => {
    const { randomUUID } = await import("node:crypto");
    const { runMigrations } = await import("../../db/sqlite/migrate");
    const { getDb } = await import("../../db/sqlite/client");
    const schema = await import("../../db/sqlite/schema");
    const { _resetBootstrapForTests, bootstrapProviders } = await import(
      "../provider/bootstrap"
    );
    await runMigrations();
    _resetBootstrapForTests();
    await bootstrapProviders();
    const db = await getDb();
    const wid = randomUUID();
    const pid = randomUUID();
    await db.insert(schema.workspace).values({ id: wid, name: "p04-hp", owner: "t" });
    await db.insert(schema.project).values({
      id: pid,
      workspaceId: wid,
      name: "p04-hp-proj",
      marketScope: "CN-A",
      status: "active",
    });

    const ctxLocal = { ...ctx, projectId: pid };
    const out = (await dispatchBuiltinTool("factor.mine.llm", ctxLocal, {
      expressions: [
        "close / Ref(close, 5) - 1",
        "Mean(close, 10) / Mean(close, 30) - 1",
        "(high - low) / close",
        "Rank(volume / Mean(volume, 20))",
        "close - Ref(close, 1)",
      ],
      symbols: ["SYN1", "SYN2", "SYN3", "SYN4"],
      start_date: "2026-01-01",
      end_date: "2026-04-30",
      top_k: 3,
      ic_threshold: 0, // 接受所有 → 让 promote 一定有非空
      auto_promote: true,
      name_prefix: "p04test",
    })) as {
      ok: boolean;
      job_id: string;
      requested: number;
      evaluated: number;
      promoted_count: number;
      top_candidates: Array<{ candidate_id: string; ic: number }>;
      promoted: Array<{ factor_id: string; name: string }>;
    };
    expect(out.ok).toBe(true);
    expect(out.requested).toBe(5);
    expect(out.evaluated).toBeGreaterThan(0);
    expect(out.top_candidates.length).toBeGreaterThan(0);
    expect(out.top_candidates.length).toBeLessThanOrEqual(3);
    expect(out.promoted_count).toBe(out.promoted.length);
    expect(out.promoted_count).toBeGreaterThan(0);
    for (const p of out.promoted) {
      expect(p.name.startsWith("p04test_")).toBe(true);
    }
  });
});

describe("connector bootstrap", () => {
  test("registers all qubit-* connectors", async () => {
    await registerBuiltinConnectors();
    expect(connectorRegistry.get("qubit-data")).toBeDefined();
    expect(connectorRegistry.get("qubit-news")).toBeDefined();
    expect(connectorRegistry.get("qubit-backtest")).toBeDefined();
    expect(connectorRegistry.get("qubit-research")).toBeDefined();
    expect(connectorRegistry.get("qubit-sim")).toBeDefined();
    expect(connectorRegistry.get("qubit-risk")).toBeDefined();
    expect(connectorRegistry.get("qubit-broker")).toBeDefined();
  });
});
