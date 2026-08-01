import type { ScenarioRecipe } from "../types";

export const stockPickRecipe: ScenarioRecipe = {
  key: "stock_pick",
  aliases: ["stock_screening", "stock_pick_long", "sp"],
  version: "2026-08-01.1",
  capabilityOwners: {
    screener: "research",
    "recommendation.record": "research",
  },
  roleToolAllowlist: {
    orchestrator: ["update_plan", "topology.dispatch"],
    research: ["run_screener", "recommendation.record"],
  },
  stallBudget: {
    tools: ["market.readiness", "market.resolve_symbol", "update_plan", "factor.list"],
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
        table: "screener_candidate",
        minRows: 3,
        requiredFields: ["ticker", "score"],
        scope: "workflow",
      },
      {
        table: "recommendation_snapshot",
        minRows: 3,
        requiredFields: ["symbol", "rationale"],
        scope: "workflow",
      },
    ],
    requiredTools: [
      { capability: "screener", minSuccess: 1 },
      { capability: "recommendation.record", minSuccess: 1 },
    ],
    answerSchema: {
      requiredSections: ["goal", "evidence", "decision", "risks", "gaps"],
    },
  },
  checklistPrompt: [
    "1. run_screener 产出候选（top_n 足够覆盖目标只数）",
    "2. 对候选逐只 recommendation.record（side=long，含入场/止损/止盈/仓位/invalidation）",
    "3. 输出五段答案；禁止 readiness/list 空转结案",
  ],
};
