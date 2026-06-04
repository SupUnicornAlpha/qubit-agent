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

  /**
   * 2026-06 拆分 Orchestrator MSA 决策汇总：原本 `runAnalystTeam` 内部强制跑的裸 LLM
   * 调用拆成 `summarize_team_decision` builtin tool，由 Orchestrator 在 ReAct loop 中
   * 按需调用。catalog 必须包含此工具且分类为 orchestration，否则 Agent 定义界面拉不到。
   */
  test("summarize_team_decision is registered in catalog and BUILTIN_HANDLERS", () => {
    expect(isBuiltinTool("summarize_team_decision")).toBe(true);
    expect(isRoutedTool("summarize_team_decision")).toBe(false);
    const catalog = buildToolCatalog();
    const entry = catalog.find((e) => e.name === "summarize_team_decision");
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("builtin");
    expect(entry?.category).toBe("orchestration");
  });

  test("summarize_team_decision rejects missing required params", async () => {
    await expect(
      dispatchBuiltinTool("summarize_team_decision", ctx, {} as Record<string, unknown>)
    ).rejects.toThrow(/fusion_summary 与 ticker 必填/);
  });

  test("4 deleted stubs are no longer registered as builtin handlers", () => {
    expect(isBuiltinTool("task_decompose")).toBe(false);
    expect(isBuiltinTool("analyze_industry")).toBe(false);
    expect(isBuiltinTool("analyze_policy")).toBe(false);
    expect(isBuiltinTool("get_analyst_ratings")).toBe(false);
  });

  /**
   * Exec 能力源接入回归（2026 "CLI vs MCP" hybrid 方案）：
   * - shell.exec / cli_agent.run 是 builtin（不是 connector / mcp）
   * - catalog 把它们归在 exec 分类、lifecycle=experimental，方便 UI 识别
   * - 默认 seed agent definitions 里只有 research / backtest 默认带 shell.exec，
   *   只有 research 默认带 cli_agent.run（避免无差别开放 attack surface）
   */
  test("exec tools registered as builtin + categorized in catalog", async () => {
    expect(isBuiltinTool("shell.exec")).toBe(true);
    expect(isBuiltinTool("cli_agent.run")).toBe(true);
    expect(isRoutedTool("shell.exec")).toBe(false);
    expect(isRoutedTool("cli_agent.run")).toBe(false);

    const catalog = buildToolCatalog();
    const shellEntry = catalog.find((e) => e.name === "shell.exec");
    const cliAgentEntry = catalog.find((e) => e.name === "cli_agent.run");
    expect(shellEntry?.kind).toBe("builtin");
    expect(shellEntry?.category).toBe("exec");
    expect(shellEntry?.lifecycle).toBe("experimental");
    expect(cliAgentEntry?.kind).toBe("builtin");
    expect(cliAgentEntry?.category).toBe("exec");
    expect(cliAgentEntry?.lifecycle).toBe("experimental");
  });

  test("seed agent defaults: research/backtest get exec tools, others don't", async () => {
    const { SEED_AGENT_DEFINITIONS } = await import("../seed-agent-definitions-data");
    const research = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-research");
    const backtest = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-backtest");
    const orchestrator = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-orchestrator");
    const analystTech = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-analyst-technical");

    expect(research?.tools).toContain("shell.exec");
    expect(research?.tools).toContain("cli_agent.run");
    expect(backtest?.tools).toContain("shell.exec");
    // backtest 暂不开 cli_agent.run（数值计算 agent，外包给 coding agent 价值不大）
    expect(backtest?.tools).not.toContain("cli_agent.run");
    // orchestrator / analyst 默认不开（保守 attack surface）
    expect(orchestrator?.tools).not.toContain("shell.exec");
    expect(orchestrator?.tools).not.toContain("cli_agent.run");
    expect(analystTech?.tools).not.toContain("shell.exec");
    expect(analystTech?.tools).not.toContain("cli_agent.run");
  });

  test("exec tools sandbox loadPolicy fall back to definition.tools when row.allowedToolsJson is empty", async () => {
    // sandbox-executor.loadPolicy 路径：
    //   - row 存在 + allowedToolsJson=[] → fall back 到 definition.tools（"wide-open dev"）
    //   - row 存在 + allowedToolsJson 非空 → 用 row 列表
    //   - row 不存在 → fail closed（空集）
    // 我们关心的是第一种 fall-back 路径必须把 shell.exec / cli_agent.run 透出来，
    // 否则 def-research 默认 SEED 起的 dev 环境就跑不通 exec 工具。
    //
    // 测试自己 seed 一个固定 id 的空 sandbox_policy + 一个临时 RuntimeAgentDefinition
    // 引用它，避免依赖 dev DB 里既存的 default-policy（混跑时其 allowedToolsJson 可能非空）。
    const { runMigrations } = await import("../../db/sqlite/migrate");
    const { getDb } = await import("../../db/sqlite/client");
    const schema = await import("../../db/sqlite/schema");
    const { SandboxExecutor } = await import("../sandbox-executor");
    const { SEED_AGENT_DEFINITIONS } = await import("../seed-agent-definitions-data");

    await runMigrations();
    const db = await getDb();
    const POLICY_ID = `sb-exec-${process.pid}`;
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: POLICY_ID, name: POLICY_ID, description: "exec test policy" })
      .onConflictDoNothing();

    const research = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-research");
    if (!research) throw new Error("def-research seed missing");

    const executor = new SandboxExecutor();
    const policy = await executor.loadPolicy({
      ...research,
      sandboxPolicyId: POLICY_ID,
    });
    expect(policy.allowedTools.has("shell.exec")).toBe(true);
    expect(policy.allowedTools.has("cli_agent.run")).toBe(true);
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
    const { _resetBootstrapForTests, bootstrapProviders } = await import("../provider/bootstrap");
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
