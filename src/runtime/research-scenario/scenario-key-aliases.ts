/**
 * Bench / readiness recipe keys → research_scenario registry keys.
 * Keep in sync with `research-scenario/service.ts` launch aliases.
 */
export const SCENARIO_KEY_ALIASES: Record<string, string> = {
  research: "analyst_debate",
  research_multi: "analyst_debate",
  research_theme: "stock_screening",
  stock_pick: "stock_screening",
  stock_pick_short: "stock_screening",
  factor: "factor_research",
  strategy: "strategy_authoring",
  strategy_long_short: "strategy_authoring",
  live_trading_short: "live_trading",
};

/** Resolve a recipe or registry key to the registry scenario key used for tool presets. */
export function resolveRegistryScenarioKey(scenarioKey: string | null | undefined): string | null {
  const key = (scenarioKey ?? "").trim();
  if (!key) return null;
  return SCENARIO_KEY_ALIASES[key] ?? key;
}

/** Preferred concrete tool for a required capability (for next-action hints). */
export const REQUIRED_CAPABILITY_PRIMARY_TOOL: Record<string, string> = {
  screener: "run_screener",
  "recommendation.record": "recommendation.record",
  factor: "factor.register",
  strategy: "strategy.create_version",
  // Strategy API 路径也可算 strategy 能力（B-1 子串/别名匹配见 data-gap）
  "strategy.compile": "strategy.compile",
  "strategy.contract_backtest": "strategy.contract_backtest",
  order: "order.create_intent",
  // Prefer order.create_intent: it embeds pre-trade risk and writes risk_decision.
  risk: "order.create_intent",
  get_quote: "fetch_klines",
  news: "fetch_news",
};

/**
 * Read/inventory tools that may run once for orientation, but must not be
 * re-invoked while scenario write-contract tools remain not_attempted.
 */
export const SCENARIO_STALL_TOOLS: ReadonlySet<string> = new Set([
  "factor.list",
  "run_screener",
  "market.readiness",
  "resolve_symbol",
  "market.resolve_symbol",
  "update_plan",
  "evaluate_risk",
]);
