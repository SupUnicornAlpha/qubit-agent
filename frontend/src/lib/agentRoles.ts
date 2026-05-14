/** 与后端 `agent_definition.role` 枚举一致（用于配置 UI 新建 Agent） */
export const AGENT_ROLE_OPTIONS = [
  "orchestrator",
  "market_data",
  "news_event",
  "research",
  "backtest",
  "simulation",
  "risk",
  "execution",
  "memory",
  "audit",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "researcher_bull",
  "researcher_bear",
  "risk_manager",
  "portfolio_manager",
  "stock_screener",
  "backtest_engineer",
  "execution_trader",
  "memory_curator",
] as const;

export type AgentRoleOption = (typeof AGENT_ROLE_OPTIONS)[number];
