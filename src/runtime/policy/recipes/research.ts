import type { ScenarioRecipe } from "../types";

export const researchRecipe: ScenarioRecipe = {
  key: "research",
  aliases: ["research_multi", "research_theme", "rs", "rm", "rt"],
  version: "2026-08-01.1",
  capabilityOwners: {
    get_quote: "research",
    news: "research",
  },
  roleToolAllowlist: {
    orchestrator: ["update_plan", "topology.dispatch"],
    research: ["fetch_klines", "fetch_quote", "fetch_news", "run_analyst_team", "fuse_signals"],
  },
  stallBudget: {
    tools: ["market.readiness", "market.data_sources", "update_plan"],
    key: "tool_market",
    maxSuccess: 1,
    onExceed: "strip_from_surface",
  },
  recovery: {
    afterProbeFailure: "degrade_source",
    forbidGapAsFinalAnswer: true,
  },
  completion: {
    artifacts: [
      {
        table: "analyst_signal",
        minRows: 2,
        requiredFields: ["ticker", "reasoning"],
        scope: "workflow",
      },
      {
        table: "signal_fusion_result",
        minRows: 1,
        scope: "workflow",
      },
    ],
    requiredTools: [
      { capability: "get_quote", minSuccess: 1 },
      { capability: "news", minSuccess: 1 },
    ],
    answerSchema: {
      requiredSections: ["goal", "evidence", "decision", "risks", "gaps"],
    },
  },
  checklistPrompt: [
    "1. 拉取价格与新闻证据",
    "2. 产出 analyst_signal + fusion",
    "3. 输出五段答案；探活失败走 data-gap，不得当唯一结案",
  ],
};
