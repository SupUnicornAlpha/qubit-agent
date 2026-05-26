/**
 * Seed Agent 定义 — 量化工坊工具装载契约测试
 *
 * 确保「因子研究 / 回测 / 风控」等编组的成员 Agent 默认装上 M2 / M6 新工具，
 * 否则用户在 UI 选「因子研究」编组发起对话时，Agent 看不到 factor.* / discovery.*
 * / backtest.run / code.run_python 等关键工具。
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
} from "../seed-agent-catalog";
import { BUILTIN_GROUP_LAYOUTS } from "../seed-agent-definitions";

const BY_ID = new Map(SEED_AGENT_DEFINITIONS.map((d) => [d.id, d]));

function expectTools(defId: string, requiredTools: string[]) {
  const def = BY_ID.get(defId);
  expect(def).toBeDefined();
  for (const tool of requiredTools) {
    expect(def!.tools).toContain(tool);
  }
}

describe("Seed Agent 定义 — 量化工坊工具契约", () => {
  test("def-research 包含 M2/M6 全套因子+规则+组合+挖掘+回测+沙箱工具", () => {
    expectTools("def-research", [
      "factor.register",
      "factor.compute",
      "factor.evaluate",
      "factor.list",
      "factor.autoEvaluate",
      "rule.register",
      "rule.evaluate",
      "strategy.compose",
      "discovery.run",
      "discovery.promote",
      "backtest.run",
      "code.run_python",
    ]);
  });

  test("def-backtest 可调用事件驱动 backtest.run + factor.list + code.run_python", () => {
    expectTools("def-backtest", [
      "backtest.run",
      "factor.list",
      "factor.compute",
      "code.run_python",
    ]);
  });

  test("def-risk 可在 chat 中创建/执行规则 + 沙箱代码执行", () => {
    expectTools("def-risk", ["rule.register", "rule.evaluate", "code.run_python"]);
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

  test("升级后 def-research / def-backtest / def-risk 版本号都跳到 4.x", () => {
    for (const id of ["def-research", "def-backtest", "def-risk"]) {
      const def = BY_ID.get(id)!;
      expect(def.version.startsWith("4.")).toBe(true);
    }
  });

  test("M9.P2 升级：4 个分析师 + news 都装上 factor.list + factor.autoEvaluate + code.run_python", () => {
    const M9_ANALYSTS = [
      "def-analyst-fundamental",
      "def-analyst-technical",
      "def-analyst-sentiment",
      "def-analyst-macro",
    ];
    for (const id of M9_ANALYSTS) {
      expectTools(id, ["factor.list", "factor.autoEvaluate", "code.run_python"]);
    }
    expectTools("def-news-event", ["code.run_python"]);
  });

  test("M9.P2 升级：4 个分析师 + news 版本号跳到 3.x", () => {
    for (const id of [
      "def-analyst-fundamental",
      "def-analyst-technical",
      "def-analyst-sentiment",
      "def-analyst-macro",
      "def-news-event",
    ]) {
      const def = BY_ID.get(id)!;
      expect(def.version.startsWith("3.")).toBe(true);
    }
  });

  test("M9.P5 升级：新增 def-walk-forward-validator agent，装齐 backtest.run + factor.evaluate.batch + code.run_python", () => {
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

  test("M9.P5 升级：grp-discovery 包含 def-walk-forward-validator 成员", () => {
    expect(DISCOVERY_GROUP.memberDefinitionIds).toContain("def-walk-forward-validator");
    expect(DISCOVERY_GROUP.memberRoles).toContain("backtest_engineer");
  });

  test("BUILTIN_AGENT_GROUPS 中的每个 group 都必须有 BUILTIN_GROUP_LAYOUTS（防止 seed 时崩溃）", () => {
    // 历史回归：M1 一次性引入 9 个新 group 但忘配 layout，导致首个 group
    // 在 seed 阶段直接抛 "Missing builtin layout for agent group ..." 让整个 backend 启动失败。
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

  // M10.A2 契约：核心 Agent 需要装上长期记忆使用工具
  test("M10.A2 升级：def-orchestrator 装上长期记忆工具（search/consolidate/refresh）", () => {
    expectTools("def-orchestrator", [
      "search_memory",
      "memory.consolidate_longterm",
      "memory.refresh_workspace",
    ]);
    const def = BY_ID.get("def-orchestrator");
    expect(def!.version).toMatch(/^3\.4/);
  });

  test("M10.A2 升级：def-research 装上长期记忆工具", () => {
    expectTools("def-research", [
      "search_memory",
      "memory.consolidate_longterm",
      "memory.refresh_workspace",
    ]);
    const def = BY_ID.get("def-research");
    expect(def!.version).toMatch(/^4\.1/);
  });

  test("M10.A2 升级：所有装上 consolidate_longterm 的 agent 必须也装 search_memory（确保闭环）", () => {
    for (const def of SEED_AGENT_DEFINITIONS) {
      const hasConsolidate = def.tools.includes("memory.consolidate_longterm");
      if (hasConsolidate) {
        expect(def.tools).toContain("search_memory");
      }
    }
  });

  test("M11 升级：9 个核心 role 默认订阅 skill.search + skill.use_record（让 LLM 能复用历史 skill）", () => {
    const minimalSkillRoles = [
      "def-orchestrator",
      "def-analyst-fundamental",
      "def-analyst-technical",
      "def-analyst-sentiment",
      "def-analyst-macro",
      "def-research",
      "def-backtest",
      "def-risk",
      "def-walk-forward-validator",
    ];
    for (const id of minimalSkillRoles) {
      const def = BY_ID.get(id);
      expect(def, `${id} missing from seed definitions`).toBeDefined();
      expect(def!.tools, `${id} missing skill.search`).toContain("skill.search");
      expect(def!.tools, `${id} missing skill.use_record`).toContain("skill.use_record");
    }
  });

  test("M11 升级：orchestrator/research/backtest/risk 装齐 skill 全套（与 SKILLS_NUDGE 提示词自洽）", () => {
    // 这 4 个 role 的 systemPrompt 都注入了完整 SKILLS_NUDGE（含 skill.create/patch/archive 引导），
    // 必须配套订阅这 3 个工具，否则 LLM 会调到一个没订阅的工具。
    const fullSkillRoles = ["def-orchestrator", "def-research", "def-backtest", "def-risk"];
    const fullToolset = ["skill.search", "skill.use_record", "skill.create", "skill.patch", "skill.archive"];
    for (const id of fullSkillRoles) {
      const def = BY_ID.get(id);
      expect(def, `${id} missing from seed definitions`).toBeDefined();
      for (const tool of fullToolset) {
        expect(def!.tools, `${id} missing ${tool}`).toContain(tool);
      }
    }
  });
});
