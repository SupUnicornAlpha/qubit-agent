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
});
