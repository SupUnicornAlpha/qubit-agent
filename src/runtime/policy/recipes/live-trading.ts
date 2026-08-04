import type { ScenarioRecipe } from "../types";

export const liveTradingRecipe: ScenarioRecipe = {
  key: "live_trading",
  aliases: ["paper_trading", "live_trading_short", "lt"],
  version: "2026-08-04.1",
  capabilityOwners: {
    strategy: "strategy",
    order: "execution",
    risk: "risk",
  },
  roleToolAllowlist: {
    orchestrator: ["update_plan", "topology.dispatch"],
    execute: ["strategy.create_version", "order.create_intent"],
  },
  stallBudget: {
    tools: [
      "market.readiness",
      "market.resolve_symbol",
      "update_plan",
      "evaluate_risk",
      "strategy.create_version",
    ],
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
        researchMinRows: 1,
        requiredFields: ["symbol", "side", "qty", "strategy_version_id"],
        scope: "workflow",
      },
      {
        table: "risk_decision",
        minRows: 1,
        /** risk_decision is upgrade-grade; research floor is order_intent. */
        researchMinRows: 0,
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
    "1. 若尚无 strategy_version_id：先 strategy.create_version（成功一次即可）",
    "2. 立刻调用 order.create_intent（symbol、side=buy|sell、qty>0、strategy_version_id、dispatch_mode=paper）；禁止 submit_order / 单独 evaluate_risk / rule.evaluate 代替",
    "3. risk_decision 由 order.create_intent 内嵌；不要先走券商 submit 或 rule.evaluate",
    "4. 输出五段答案；不得仅以行情不可用结案",
  ],
};
