import type { ScenarioRecipe } from "../types";

export const liveTradingRecipe: ScenarioRecipe = {
  key: "live_trading",
  aliases: ["paper_trading", "lt"],
  version: "2026-08-01.1",
  capabilityOwners: {
    strategy: "strategy",
    order: "execution",
    risk: "risk",
  },
  roleToolAllowlist: {
    orchestrator: ["update_plan", "topology.dispatch"],
    execute: ["strategy.create_version", "order.create_intent", "evaluate_risk"],
  },
  stallBudget: {
    tools: ["market.readiness", "market.resolve_symbol", "update_plan", "evaluate_risk"],
    key: "tool_fingerprint",
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
        table: "order_intent",
        minRows: 1,
        requiredFields: ["symbol", "side", "qty", "strategy_version_id"],
        scope: "workflow",
      },
      {
        table: "risk_decision",
        minRows: 1,
        requiredFields: ["decision"],
        scope: "workflow",
      },
    ],
    requiredTools: [{ capability: "order.create_intent", minSuccess: 1 }],
    answerSchema: {
      requiredSections: ["goal", "evidence", "decision", "risks", "gaps"],
    },
  },
  checklistPrompt: [
    "1. 若尚无 strategy_version_id：先 strategy.create_version",
    "2. order.create_intent：必须传 symbol、side=buy|sell（勿用 direction）、qty>0、上一步返回的 strategy_version_id、dispatch_mode=paper",
    "3. 确保 risk_decision 落库（order.create_intent 会内嵌 pre-trade）",
    "4. 输出五段答案；不得仅以行情不可用结案",
  ],
};
