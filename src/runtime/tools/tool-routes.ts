/**
 * Maps agent tool names (configured on definitions) to builtin ACP connectors.
 * Operations are passed as `operation` in the ACP payload (see act node).
 */
export const TOOL_CONNECTOR_ROUTES: Record<string, string> = {
  // qubit-data
  fetch_bars: "qubit-data",
  fetch_klines: "qubit-data",
  fetch_ticks: "qubit-data",
  fetch_price_data: "qubit-data",
  fetch_financial_data: "qubit-data",
  fetch_fundamentals: "qubit-data",
  write_snapshot: "qubit-data",
  // qubit-news
  fetch_news: "qubit-news",
  fetch_news_sentiment: "qubit-news",
  extract_event: "qubit-news",
  score_sentiment: "qubit-news",
  // qubit-backtest
  run_backtest: "qubit-backtest",
  get_backtest_status: "qubit-backtest",
  // qubit-research
  compute_factors: "qubit-research",
  run_experiment: "qubit-research",
  version_strategy: "qubit-research",
  // qubit-sim
  submit_paper_order: "qubit-sim",
  get_paper_position: "qubit-sim",
  // qubit-broker
  submit_order: "qubit-broker",
  cancel_order: "qubit-broker",
  get_fills: "qubit-broker",
  // qubit-risk
  evaluate_risk: "qubit-risk",
  sign_intent: "qubit-risk",
  load_rules: "qubit-risk",
  check_risk: "qubit-risk",
  check_concentration: "qubit-risk",
  assess_liquidity: "qubit-risk",
};

export function resolveConnectorForTool(toolName: string): string | undefined {
  return TOOL_CONNECTOR_ROUTES[toolName];
}

/** call_mcp 误用 connector 名作为 serverName 时，映射到内置 connector */
export function resolveConnectorForServerAlias(serverName: string): string | undefined {
  const known = new Set(Object.values(TOOL_CONNECTOR_ROUTES));
  return known.has(serverName) ? serverName : undefined;
}
