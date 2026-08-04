import type { ScenarioRecipe } from "../types";

export const strategyRecipe: ScenarioRecipe = {
  key: "strategy",
  aliases: ["strategy_authoring", "strategy_long_short", "st", "long_short"],
  version: "2026-08-04.1",
  capabilityOwners: {
    strategy: "strategy",
  },
  roleToolAllowlist: {
    orchestrator: ["update_plan", "topology.dispatch"],
    strategy: ["strategy.create_version", "strategy.compose", "backtest.run"],
  },
  stallBudget: {
    tools: [
      "market.readiness",
      "market.resolve_symbol",
      "factor.list",
      "run_screener",
      "update_plan",
      "run_backtest",
    ],
    key: "tool",
    maxSuccess: 1,
    onExceed: "strip_from_surface",
  },
  recovery: {
    afterProbeFailure: "continue_without_realtime",
    forbidGapAsFinalAnswer: true,
  },
  completion: {
    artifacts: [
      {
        table: "strategy_version",
        minRows: 1,
        researchMinRows: 1,
        requiredFields: ["name"],
        scope: "workflow",
      },
      {
        table: "strategy_composition",
        minRows: 1,
        researchMinRows: 0,
        scope: "workflow",
      },
    ],
    requiredTools: [{ capability: "strategy", minSuccess: 1 }],
    answerSchema: {
      requiredSections: ["goal", "evidence", "decision", "risks", "gaps"],
    },
  },
  checklistPrompt: [
    "1. strategy.create_version",
    "2. strategy.compose",
    "3. backtest.run（如工具面允许）",
    "4. 输出五段答案；禁止 screener/readiness/factor.list 代替策略交付",
  ],
};
