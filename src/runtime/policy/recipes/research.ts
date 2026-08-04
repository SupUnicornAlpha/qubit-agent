import type { ScenarioRecipe } from "../types";

export const researchRecipe: ScenarioRecipe = {
  key: "research",
  aliases: ["research_multi", "research_theme", "rs", "rm", "rt"],
  version: "2026-08-04.1",
  capabilityOwners: {
    get_quote: "research",
    news: "research",
  },
  roleToolAllowlist: {
    orchestrator: ["update_plan", "topology.dispatch"],
    research: ["fetch_klines", "fetch_quote", "fetch_news", "run_analyst_team", "fuse_signals"],
  },
  stallBudget: {
    // Cap klines churn: multi-ticker research may need a few quotes, not 20+.
    tools: [
      "market.readiness",
      "market.data_sources",
      "update_plan",
      "fetch_klines",
      "fetch_quote",
      "fetch_bars",
      "fetch_price_data",
    ],
    key: "tool",
    maxSuccess: 4,
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
    "1. fetch_klines 取价（够用即可，禁止对同一证据面空转连打）",
    "2. fetch_news 取新闻/事件；缺新闻必须显式记录缺口，不得只刷行情",
    "3. 产出 analyst_signal + fusion（可经 run_analyst_team）",
    "4. 输出五段答案；探活失败走 data-gap，不得当唯一结案",
  ],
};
