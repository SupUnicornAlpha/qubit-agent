import type { ScenarioRecipe } from "../types";

export const strategyRecipe: ScenarioRecipe = {
  key: "strategy",
  aliases: ["strategy_authoring", "st", "long_short"],
  version: "2026-08-01.1",
  capabilityOwners: {
    strategy: "strategy",
  },
  roleToolAllowlist: {
    orchestrator: ["update_plan", "topology.dispatch"],
    strategy: [
      "strategy.create_version",
      "strategy.compose",
      "backtest.run",
      "run_backtest",
      "factor.list",
    ],
  },
  stallBudget: {
    tools: ["market.readiness", "market.resolve_symbol", "factor.list", "run_screener", "update_plan"],
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
        requiredFields: ["name"],
        scope: "workflow",
      },
      {
        table: "strategy_composition",
        minRows: 1,
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
    "4. 输出五段答案；禁止 screener/readiness 代替策略交付",
  ],
};
