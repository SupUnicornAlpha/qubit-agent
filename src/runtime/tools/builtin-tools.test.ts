import { describe, expect, test } from "bun:test";
import { registerBuiltinConnectors } from "../../connectors/bootstrap";
import { connectorRegistry } from "../../connectors/registry";
import {
  dispatchBuiltinTool,
  isBuiltinTool,
  isRoutedTool,
  listRegisteredBuiltinTools,
  resolveDelegatedParentTaskId,
} from "./builtin-tools";
import { buildToolCatalog } from "./tool-catalog";
import { resolveConnectorForTool } from "./tool-routes";

describe("tool routes", () => {
  test("connector routes exclude tools migrated to builtin", () => {
    expect(resolveConnectorForTool("fetch_klines")).toBe("qubit-data");
    expect(resolveConnectorForTool("run_backtest")).toBe("qubit-backtest");
    expect(resolveConnectorForTool("compute_factors")).toBeUndefined();
    expect(resolveConnectorForTool("evaluate_risk")).toBe("qubit-risk");
  });

  test("builtin tools are not double-routed", () => {
    expect(isRoutedTool("assign_task")).toBe(false);
    expect(isBuiltinTool("assign_task")).toBe(true);
    expect(isBuiltinTool("fetch_klines")).toBe(false);
    expect(isBuiltinTool("call_team_research")).toBe(true);
  });
});

describe("topology delegation lineage", () => {
  test("carries the inbound A2A task as the durable parent", () => {
    expect(resolveDelegatedParentTaskId({ taskId: " parent-task " })).toBe("parent-task");
    expect(resolveDelegatedParentTaskId({ taskId: "  " })).toBeNull();
    expect(resolveDelegatedParentTaskId(undefined)).toBeNull();
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
    expect(catalog.some((e) => e.name === "run_analyst_team")).toBe(false);
    expect(listRegisteredBuiltinTools().length).toBeGreaterThan(10);
  });

  /**
   * Phase A：团队兼容大工具已退役——仍注册 handler 以便旧定义 fail-closed，
   * 但不进 catalog；调用一律硬拒绝。
   */
  test("team-compat tools are not advertised but reject when invoked", async () => {
    for (const name of ["run_analyst_team", "summarize_team_decision", "fuse_signals"] as const) {
      expect(isBuiltinTool(name)).toBe(true);
      expect(isRoutedTool(name)).toBe(false);
      expect(buildToolCatalog().some((e) => e.name === name)).toBe(false);
      await expect(
        dispatchBuiltinTool(name, ctx, {} as Record<string, unknown>)
      ).rejects.toThrow(/已退役|Phase A/);
    }
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
   * - 精品面后默认 seed 不再给 research/backtest 挂 shell.exec（需手工开权）
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

  test("seed agent defaults: research/backtest no longer ship shell.exec by default", async () => {
    const { SEED_AGENT_DEFINITIONS } = await import("../seed-agent-definitions-data");
    const research = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-research");
    const backtest = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-backtest");
    const orchestrator = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-orchestrator");
    const analystTech = SEED_AGENT_DEFINITIONS.find((d) => d.id === "def-analyst-technical");

    // 精品面：exec 不进入默认专家授权；需要时由策略包/手工开权。
    expect(research?.tools).not.toContain("shell.exec");
    expect(research?.tools).not.toContain("cli_agent.run");
    expect(backtest?.tools).not.toContain("shell.exec");
    expect(backtest?.tools).not.toContain("cli_agent.run");
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
    // 精品面后 research 默认不再含 shell.exec；本测验证 fall-back 能透出定义里声明的工具。
    const { randomUUID } = await import("node:crypto");
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
      // 临时挂上 exec，只验证 sandbox fall-back 透传 definition.tools
      tools: [...research.tools, "shell.exec", "cli_agent.run"],
      sandboxPolicyId: POLICY_ID,
    });
    expect(policy.allowedTools.has("shell.exec")).toBe(true);
    expect(policy.allowedTools.has("cli_agent.run")).toBe(true);
    expect(policy.allowedTools.has("factor.register")).toBe(true);
    void randomUUID;
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

describe("research.thesis.write builtin", () => {
  test("is registered and catalogued", () => {
    expect(isBuiltinTool("research.thesis.write")).toBe(true);
    expect(isBuiltinTool("research.framework.assess")).toBe(true);
    expect(isBuiltinTool("strategy.champion_challenger.compare")).toBe(true);
    expect(isBuiltinTool("strategy.candidate.review")).toBe(true);
    expect(isBuiltinTool("research.forecast_book.get")).toBe(true);
    expect(isBuiltinTool("research.forecast_book.link")).toBe(true);
    expect(isBuiltinTool("portfolio.construct")).toBe(true);
    const entry = buildToolCatalog().find((row) => row.name === "research.thesis.write");
    expect(entry?.category).toBe("research");
    expect(entry?.description).toContain("thesisId");
  });

  test("requires symbols when snapshot and narrative omit them", async () => {
    await expect(
      dispatchBuiltinTool("research.thesis.write", ctx, {
        direction: "long",
      })
    ).rejects.toThrow(/instrumentScope|symbols/);
  });

  test("infers symbols from narrative and soft-binds snapshot", async () => {
    const out = (await dispatchBuiltinTool("research.thesis.write", ctx, {
      narrative: "看多 600519.SH 短期反弹",
      direction: "看多",
    })) as {
      ok?: boolean;
      thesisId?: string;
      snapshotId?: string;
      snapshotBinding?: string;
    };
    expect(out.ok).toBe(true);
    expect(out.thesisId).toMatch(/^thesis_/);
    expect(out.snapshotId).toBeTruthy();
    expect(["auto", "unbound", "explicit"]).toContain(out.snapshotBinding);
  });

  test("screens candidates through a frozen framework card", async () => {
    const frameworkCard = {
      version: "investment-framework-card-v1",
      framework: "quality_growth",
      sourceRefs: ["source:quality-growth"],
      principles: [{ statement: "Quality compounds capital.", sourceRefs: ["source:quality-growth"] }],
      economicMechanism: "High returns plus reinvestment can compound shareholder capital.",
      observableProxies: [
        {
          key: "roic",
          label: "ROIC",
          comparison: "gte",
          threshold: 0.15,
          weight: 1,
          sourceRefs: ["source:quality-growth"],
        },
      ],
      selectionThreshold: 1,
      applicability: {
        assetClasses: ["equity"],
        markets: ["US"],
        regimes: ["normal"],
        holdingPeriod: "12m",
      },
      exclusionConditions: ["Financial statements unavailable."],
      invalidation: [{ condition: "ROIC falls below threshold.", observable: "fund_roic" }],
      riskBudget: { maxPositionWeightPct: 0.1, maxPortfolioDrawdownPct: 0.15 },
    } as const;
    const written = (await dispatchBuiltinTool("research.thesis.write", ctx, {
      thesisId: "thesis_framework_assess_e2e",
      snapshotId: "mkt_snapshot_framework_assess_e2e",
      symbols: ["AAPL"],
      direction: "long",
      confidence: 0.7,
      framework: "quality_growth",
      frameworkCard,
      claims: [{ claim: "Quality score is durable.", evidenceRefs: ["fundamental:roic:2026q2"] }],
      invalidation: [{ condition: "ROIC falls below threshold.", observable: "fund_roic" }],
    })) as { thesisId: string };

    const assessed = (await dispatchBuiltinTool("research.framework.assess", ctx, {
      thesisId: written.thesisId,
      candidates: [
        {
          symbol: "AAPL",
          assetClass: "equity",
          market: "US",
          regime: "normal",
          observations: { roic: { value: 0.2, evidenceRefs: ["fundamental:roic:2026q2"] } },
        },
        {
          symbol: "BTC-USD",
          assetClass: "crypto",
          market: "CRYPTO",
          regime: "normal",
          observations: { roic: { value: 0.2, evidenceRefs: ["fundamental:roic:2026q2"] } },
        },
      ],
    })) as { qualifiedSymbols: string[]; assessments: Array<{ status: string }> };

    expect(assessed.qualifiedSymbols).toEqual(["AAPL"]);
    expect(assessed.assessments.map((row) => row.status)).toEqual(["qualified", "rejected"]);
  });
});

describe("market.snapshot.get builtin", () => {
  test("is registered as builtin and catalogued", () => {
    expect(isBuiltinTool("market.snapshot.get")).toBe(true);
    const entry = buildToolCatalog().find((row) => row.name === "market.snapshot.get");
    expect(entry?.category).toBe("market");
    expect(entry?.description).toContain("snapshotId");
  });

  test("missing symbol rejects", async () => {
    await expect(dispatchBuiltinTool("market.snapshot.get", ctx, {})).rejects.toThrow(
      /missing_symbol/
    );
  });

  test("unknown snapshotId rejects", async () => {
    await expect(
      dispatchBuiltinTool("market.snapshot.get", ctx, {
        snapshotId: "mkt_snapshot_does_not_exist_zzzz",
      })
    ).rejects.toThrow(/snapshot_not_found/);
  });

  test("rejects unversioned historical evidence before fetching data", async () => {
    await expect(
      dispatchBuiltinTool("market.snapshot.get", ctx, {
        symbol: "AAPL",
        universe_history: { version: "missing required evidence" },
      })
    ).rejects.toThrow(/universe_history/);
    await expect(
      dispatchBuiltinTool("market.snapshot.get", ctx, {
        symbol: "AAPL",
        corporate_action_ledger: { version: "missing required evidence" },
      })
    ).rejects.toThrow(/corporate_action_ledger/);
    await expect(
      dispatchBuiltinTool("market.snapshot.get", ctx, {
        symbol: "AAPL",
        fundamental_ledger: { version: "missing required evidence" },
      })
    ).rejects.toThrow(/fundamental_ledger/);
    await expect(
      dispatchBuiltinTool("market.snapshot.get", ctx, {
        symbol: "AAPL",
        calendar_session_windows_by_venue: { US: { "2026-01-01": [{ openAt: "bad" }] } },
      })
    ).rejects.toThrow(/calendar_session_windows_by_venue/);
    await expect(
      dispatchBuiltinTool("market.snapshot.get", ctx, {
        symbol: "AAPL",
        derivative_pricing_ledger: { version: "missing pricing provenance" },
      })
    ).rejects.toThrow(/derivative_pricing_ledger/);
  });
});

describe("IDE subscription and broker quote tools", () => {
  test("are separately registered and catalogued", () => {
    expect(isBuiltinTool("market.ide_subscription.get")).toBe(true);
    expect(isBuiltinTool("market.broker_quote.get")).toBe(true);
    const catalog = buildToolCatalog();
    expect(
      catalog.find((row) => row.name === "market.ide_subscription.get")?.description
    ).toContain("不访问 Agent 记忆");
    expect(catalog.find((row) => row.name === "market.broker_quote.get")?.description).toContain(
      "券商行情桥"
    );
  });

  test("broker quote rejects an ambiguous empty request before touching a bridge", async () => {
    await expect(dispatchBuiltinTool("market.broker_quote.get", ctx, {})).rejects.toThrow(
      /missing_symbol/
    );
  });
});

describe("market.resolve_symbol ToolContract", () => {
  test("batch symbols returns {results,count}", async () => {
    const out = (await dispatchBuiltinTool("market.resolve_symbol", ctx, {
      symbols: ["603986.SH", "002384.SZ"],
    })) as { results: unknown[]; count: number };
    expect(out.count).toBe(2);
    expect(out.results).toHaveLength(2);
  });

  test("single symbol stays flat (no results wrapper)", async () => {
    const out = (await dispatchBuiltinTool("market.resolve_symbol", ctx, {
      symbol: "AAPL",
    })) as { symbol?: string; results?: unknown };
    expect(out.results).toBeUndefined();
    expect(
      typeof out.symbol === "string" || typeof (out as { ticker?: string }).ticker === "string"
    ).toBe(true);
  });

  test("empty params → missing_symbol", async () => {
    await expect(dispatchBuiltinTool("market.resolve_symbol", ctx, {})).rejects.toThrow(
      /missing_symbol/
    );
  });
});
