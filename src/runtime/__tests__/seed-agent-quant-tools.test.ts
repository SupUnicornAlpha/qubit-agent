/**
 * Seed Agent 定义 — 精品工具面契约
 *
 * 2026-08-04：专家 ≤10 官方 tool；Orchestrator 持有合同写工具与派单权。
 */

import { describe, expect, test } from "bun:test";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";
import {
  BUILTIN_AGENT_GROUPS,
  DISCOVERY_GROUP,
  FACTOR_RESEARCH_GROUP,
  PORTFOLIO_MANAGEMENT_GROUP,
  RISK_REVIEW_GROUP,
  RULE_RESEARCH_GROUP,
  STRATEGY_PIPELINE_GROUP,
} from "../seed-agent-catalog";
import { BUILTIN_GROUP_LAYOUTS } from "../seed-agent-definitions";

const BY_ID = new Map(SEED_AGENT_DEFINITIONS.map((d) => [d.id, d]));

const SPECIALIST_IDS = [
  "def-market-data",
  "def-news-event",
  "def-analyst-fundamental",
  "def-analyst-technical",
  "def-analyst-sentiment",
  "def-analyst-macro",
  "def-research",
  "def-backtest",
  "def-risk",
  "def-walk-forward-validator",
] as const;

function expectTools(defId: string, requiredTools: string[]) {
  const def = BY_ID.get(defId);
  expect(def).toBeDefined();
  for (const tool of requiredTools) {
    expect(def!.tools).toContain(tool);
  }
}

describe("Seed Agent 定义 — 精品工具面契约", () => {
  test("每个专家 Agent 默认授权工具 ≤10", () => {
    for (const id of SPECIALIST_IDS) {
      const def = BY_ID.get(id)!;
      expect(def.tools.length, `${id} has ${def.tools.length} tools`).toBeLessThanOrEqual(10);
    }
  });

  test("专家默认保留最小 skill.search + skill.use_record", () => {
    for (const id of SPECIALIST_IDS) {
      expectTools(id, ["skill.search", "skill.use_record"]);
    }
  });

  test("def-research 保留因子→策略→回测主链，不含 discovery/下单/行情狂刷", () => {
    expectTools("def-research", [
      "factor.register",
      "factor.compute",
      "factor.evaluate",
      "factor.list",
      "strategy.create_version",
      "strategy.compose",
      "backtest.run",
    ]);
    const research = BY_ID.get("def-research")!;
    expect(research.tools).not.toContain("discovery.run");
    expect(research.tools).not.toContain("order.create_intent");
    expect(research.tools).not.toContain("fetch_klines");
    expect(research.tools).not.toContain("recommendation.record");
    expect(research.tools).not.toContain("shell.exec");
    expect(research.tools).not.toContain("cli_agent.run");
  });

  test("def-strategy-coder 持 Strategy API 写码验证链（≤10）", () => {
    expectTools("def-strategy-coder", [
      "strategy.compile",
      "strategy.contract_backtest",
      "strategy.paper_deploy",
      "strategy.paper_run",
      "strategy.create_version",
      "code.run_python",
      "skill.search",
      "skill.use_record",
    ]);
    const coder = BY_ID.get("def-strategy-coder")!;
    expect(coder.tools.length).toBeLessThanOrEqual(10);
    expect(coder.tools).not.toContain("order.create_intent");
    expect(coder.tools).not.toContain("strategy.compose");
  });

  test("def-strategy-coder 是 on-demand subagent，不在策略撰写固定编组", () => {
    const coder = BY_ID.get("def-strategy-coder")!;
    expect(coder.executionKind).toBe("subagent");
    expect(STRATEGY_PIPELINE_GROUP.memberDefinitionIds).not.toContain("def-strategy-coder");
    expect(STRATEGY_PIPELINE_GROUP.memberDefinitionIds.length).toBe(
      STRATEGY_PIPELINE_GROUP.memberRoles.length
    );
  });

  test("def-backtest 可调用事件驱动 backtest.run + factor 计算", () => {
    expectTools("def-backtest", [
      "backtest.run",
      "factor.list",
      "factor.compute",
      "code.run_python",
    ]);
  });

  test("def-risk 签核本职，不挂行情/MCP/skill 编辑", () => {
    expectTools("def-risk", ["rule.register", "rule.evaluate", "sign_intent", "evaluate_risk"]);
    const risk = BY_ID.get("def-risk")!;
    expect(risk.tools).not.toContain("fetch_klines");
    expect(risk.tools).not.toContain("call_mcp");
    expect(risk.tools).not.toContain("skill.create");
    expect(risk.tools).not.toContain("code.run_python");
  });

  test("因子研究编组成员的 definition 都存在", () => {
    for (const defId of FACTOR_RESEARCH_GROUP.memberDefinitionIds) {
      expect(BY_ID.has(defId)).toBe(true);
    }
  });

  test("规则研究编组 / 风控审查编组 / PM编组 / 挖掘编组：成员 definition 都存在", () => {
    for (const grp of [
      RULE_RESEARCH_GROUP,
      RISK_REVIEW_GROUP,
      PORTFOLIO_MANAGEMENT_GROUP,
      DISCOVERY_GROUP,
    ]) {
      for (const defId of grp.memberDefinitionIds) {
        expect(BY_ID.has(defId)).toBe(true);
      }
    }
  });

  test("def-research / def-backtest / def-risk 版本号都在 4.x", () => {
    for (const id of ["def-research", "def-backtest", "def-risk"]) {
      const def = BY_ID.get(id)!;
      expect(def.version.startsWith("4.")).toBe(true);
    }
  });

  test("分析师不自带行情治理；基本面不含 klines", () => {
    const fundamental = BY_ID.get("def-analyst-fundamental")!;
    expect(fundamental.tools).not.toContain("fetch_klines");
    expect(fundamental.tools).not.toContain("market.readiness");
    expectTools("def-analyst-fundamental", [
      "fetch_fundamentals",
      "compute_valuation",
      "research.thesis.write",
    ]);

    expectTools("def-analyst-technical", [
      "fetch_klines",
      "compute_indicators",
      "research.thesis.write",
    ]);
    expect(BY_ID.get("def-analyst-technical")!.tools).not.toContain("market.readiness");

    expectTools("def-news-event", ["fetch_news", "fetch_news_sentiment"]);
    expect(BY_ID.get("def-news-event")!.tools).not.toContain("code.run_python");
  });

  test("分析师 / news 版本号在 3.x；market_data 在 2.x", () => {
    for (const id of [
      "def-analyst-fundamental",
      "def-analyst-technical",
      "def-analyst-sentiment",
      "def-analyst-macro",
      "def-news-event",
    ]) {
      expect(BY_ID.get(id)!.version.startsWith("3.")).toBe(true);
    }
    expect(BY_ID.get("def-market-data")!.version.startsWith("2.")).toBe(true);
  });

  test("def-walk-forward-validator 装齐 backtest + batch evaluate", () => {
    const def = BY_ID.get("def-walk-forward-validator");
    expect(def).toBeDefined();
    expect(def!.role).toBe("backtest_engineer");
    expectTools("def-walk-forward-validator", [
      "backtest.run",
      "factor.list",
      "factor.autoEvaluate",
      "factor.evaluate.batch",
      "code.run_python",
    ]);
  });

  test("grp-discovery 包含 def-walk-forward-validator 成员", () => {
    expect(DISCOVERY_GROUP.memberDefinitionIds).toContain("def-walk-forward-validator");
    expect(DISCOVERY_GROUP.memberRoles).toContain("backtest_engineer");
  });

  test("BUILTIN_AGENT_GROUPS 中的每个 group 都必须有 BUILTIN_GROUP_LAYOUTS", () => {
    const missing: string[] = [];
    for (const grp of BUILTIN_AGENT_GROUPS) {
      if (!BUILTIN_GROUP_LAYOUTS[grp.id]) missing.push(grp.id);
    }
    expect(missing).toEqual([]);
  });

  test("每个 group 的 memberRoles 都必须在该 group 的 nodePositions 里有坐标", () => {
    const broken: Array<{ groupId: string; missing: string[] }> = [];
    for (const grp of BUILTIN_AGENT_GROUPS) {
      const layout = BUILTIN_GROUP_LAYOUTS[grp.id];
      if (!layout) continue;
      const lacking = grp.memberRoles.filter((r) => !(r in layout.nodePositions));
      if (lacking.length > 0) broken.push({ groupId: grp.id, missing: lacking });
    }
    expect(broken).toEqual([]);
  });

  test("Orchestrator 持有合同写工具 + 记忆 + skill 全套，不挂团队兼容大工具", () => {
    expectTools("def-orchestrator", [
      "update_plan",
      "assign_task",
      "market.resolve_symbol",
      "market.snapshot.get",
      "research.thesis.write",
      "research.forecast_book.get",
      "portfolio.construct",
      "order.create_intent",
      "run_screener",
      "recommendation.record",
      "factor.register",
      "discovery.run",
      "discovery.promote",
      "strategy.create_version",
      "strategy.compose",
      "strategy.compile",
      "strategy.contract_backtest",
      "strategy.paper_deploy",
      "strategy.paper_run",
      "backtest.run",
      "evaluate_risk",
      "rule.register",
      "search_memory",
      "memory.consolidate_longterm",
      "memory.refresh_workspace",
      "skill.search",
      "skill.use_record",
      "skill.create",
      "skill.patch",
      "skill.archive",
      "web.search",
      "web.fetch",
    ]);
    const def = BY_ID.get("def-orchestrator")!;
    expect(def.version).toMatch(/^4\./);
    expect(def.tools).toContain("web.search");
    expect(def.tools).toContain("web.fetch");
    expect(def.tools).not.toContain("call_mcp");
    expect(def.tools).not.toContain("run_analyst_team");
    expect(def.tools).not.toContain("summarize_team_decision");
    expect(def.tools).not.toContain("fuse_signals");
    expect(def.tools).not.toContain("edit_agent_pack");
    expect(def.tools).not.toContain("market.readiness");
    expect(def.tools).not.toContain("factor.list");
    expect(def.tools).not.toContain("research.forecast_book.link");
    expect(def.tools).not.toContain("fetch_klines");
  });

  test("装上 consolidate_longterm 的 agent 必须也装 search_memory", () => {
    for (const def of SEED_AGENT_DEFINITIONS) {
      if (def.tools.includes("memory.consolidate_longterm")) {
        expect(def.tools).toContain("search_memory");
      }
    }
  });

  test("仅 orchestrator 默认装齐 skill 编辑全套", () => {
    const fullToolset = [
      "skill.search",
      "skill.use_record",
      "skill.create",
      "skill.patch",
      "skill.archive",
    ];
    for (const tool of fullToolset) {
      expect(BY_ID.get("def-orchestrator")!.tools).toContain(tool);
    }
    for (const id of ["def-research", "def-backtest", "def-risk"]) {
      expect(BY_ID.get(id)!.tools).not.toContain("skill.create");
      expect(BY_ID.get(id)!.tools).not.toContain("skill.patch");
      expect(BY_ID.get(id)!.tools).not.toContain("skill.archive");
    }
  });

  test("低可用 / stub / 跨域工具不在默认授权面", () => {
    const forbiddenByRole: Record<string, string[]> = {
      "def-market-data": [
        "fetch_order_book",
        "fetch_trades",
        "fetch_chip_distribution",
        "fetch_bars",
        "fetch_ticks",
        "write_snapshot",
        "call_mcp",
      ],
      "def-analyst-technical": [
        "fetch_order_book",
        "run_screener",
        "run_experiment",
        "edit_agent_pack",
        "market.readiness",
      ],
      "def-analyst-fundamental": [
        "run_screener",
        "edit_agent_pack",
        "fetch_financial_data",
        "fetch_klines",
      ],
      "def-analyst-sentiment": [
        "analyze_social_media",
        "extract_event",
        "score_sentiment",
        "run_screener",
        "factor.register",
      ],
      "def-news-event": ["extract_event", "score_sentiment", "code.run_python"],
      "def-research": [
        "shell.exec",
        "cli_agent.run",
        "order.create_intent",
        "run_experiment",
        "discovery.run",
        "fetch_klines",
      ],
      "def-risk": ["call_mcp", "skill.create", "fetch_klines", "code.run_python"],
    };
    for (const [id, forbidden] of Object.entries(forbiddenByRole)) {
      const def = BY_ID.get(id)!;
      for (const tool of forbidden) {
        expect(def.tools, `${id} should not expose ${tool}`).not.toContain(tool);
      }
    }
  });
});
