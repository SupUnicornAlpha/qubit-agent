import type { RuntimeAgentDefinition } from "./types";
import { ROLE_CONNECTOR_MCPS, ROLE_SKILLS, resolveSeedMcpServers } from "./seed-agent-catalog";
import {
  PROMPT_ANALYST_FUNDAMENTAL,
  PROMPT_ANALYST_MACRO,
  PROMPT_ANALYST_SENTIMENT,
  PROMPT_ANALYST_TECHNICAL,
  PROMPT_BACKTEST,
  PROMPT_MARKET_DATA,
  PROMPT_NEWS_EVENT,
  PROMPT_ORCHESTRATOR,
  PROMPT_RESEARCH,
  PROMPT_RISK,
} from "./seed-agent-prompts";

function def(
  partial: RuntimeAgentDefinition & { enabled?: boolean }
): RuntimeAgentDefinition {
  const role = partial.role;
  const baseMcp = ROLE_CONNECTOR_MCPS[role] ?? [];
  return {
    ...partial,
    mcpServers: resolveSeedMcpServers(role, partial.mcpServers ?? baseMcp),
    skills: partial.skills ?? ROLE_SKILLS[role] ?? [],
    subscriptions: partial.subscriptions ?? ["TASK_ASSIGN"],
    llmProvider: partial.llmProvider ?? "openai:gpt-4o",
    maxIterations: partial.maxIterations ?? 20,
    sandboxPolicyId: partial.sandboxPolicyId ?? "default-policy",
    enabled: partial.enabled ?? true,
  };
}

/** 内置 Agent 定义（10 个）：Orchestrator + 数据/新闻 + 四维分析师 + 研究/回测/风控 */
export const SEED_AGENT_DEFINITIONS: RuntimeAgentDefinition[] = [
  def({
    id: "def-orchestrator",
    role: "orchestrator",
    name: "编排器",
    version: "3.3.0",
    systemPrompt: PROMPT_ORCHESTRATOR,
    tools: [
      "task_decompose",
      "assign_task",
      "run_analyst_team",
      "fuse_signals",
      "check_risk",
      "edit_agent_pack",
      "call_mcp",
    ],
    subscriptions: ["TASK_ASSIGN", "TASK_RESULT", "ALERT", "RISK_BLOCK"],
    maxIterations: 24,
  }),
  def({
    id: "def-market-data",
    role: "market_data",
    name: "行情数据",
    version: "2.1.0",
    systemPrompt: PROMPT_MARKET_DATA,
    tools: ["fetch_bars", "fetch_klines", "fetch_ticks", "write_snapshot", "call_mcp"],
    maxIterations: 12,
  }),
  def({
    id: "def-news-event",
    role: "news_event",
    name: "新闻事件",
    version: "2.1.0",
    systemPrompt: PROMPT_NEWS_EVENT,
    tools: ["fetch_news", "extract_event", "score_sentiment", "call_mcp"],
    maxIterations: 12,
  }),
  def({
    id: "def-analyst-fundamental",
    role: "analyst_fundamental",
    name: "基本面研究员",
    version: "2.1.0",
    systemPrompt: PROMPT_ANALYST_FUNDAMENTAL,
    tools: [
      "fetch_financial_data",
      "fetch_klines",
      "compute_valuation",
      "analyze_industry",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 10,
  }),
  def({
    id: "def-analyst-technical",
    role: "analyst_technical",
    name: "量化策略师",
    version: "2.1.0",
    systemPrompt: PROMPT_ANALYST_TECHNICAL,
    tools: [
      "fetch_price_data",
      "fetch_klines",
      "compute_indicators",
      "detect_patterns",
      "run_backtest",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 10,
  }),
  def({
    id: "def-analyst-sentiment",
    role: "analyst_sentiment",
    name: "舆情分析师",
    version: "2.1.0",
    systemPrompt: PROMPT_ANALYST_SENTIMENT,
    tools: [
      "fetch_news",
      "fetch_news_sentiment",
      "analyze_social_media",
      "get_analyst_ratings",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 10,
  }),
  def({
    id: "def-analyst-macro",
    role: "analyst_macro",
    name: "宏观策略师",
    version: "2.1.0",
    systemPrompt: PROMPT_ANALYST_MACRO,
    tools: [
      "fetch_macro_data",
      "fetch_klines",
      "analyze_policy",
      "compute_macro_indicators",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 10,
  }),
  def({
    id: "def-research",
    role: "research",
    name: "策略研究",
    version: "3.2.0",
    systemPrompt: PROMPT_RESEARCH,
    tools: [
      "fetch_klines",
      "compute_factors",
      "run_experiment",
      "version_strategy",
      "edit_agent_pack",
      "call_mcp",
    ],
    subscriptions: ["TASK_ASSIGN", "MODEL_UPDATE"],
  }),
  def({
    id: "def-backtest",
    role: "backtest",
    name: "回测",
    version: "3.1.0",
    systemPrompt: PROMPT_BACKTEST,
    tools: ["fetch_klines", "run_backtest", "get_backtest_status", "compute_indicators", "call_mcp"],
    maxIterations: 16,
  }),
  def({
    id: "def-risk",
    role: "risk",
    name: "风控",
    version: "3.1.0",
    systemPrompt: PROMPT_RISK,
    tools: [
      "evaluate_risk",
      "sign_intent",
      "load_rules",
      "check_concentration",
      "assess_liquidity",
    ],
    subscriptions: ["TASK_ASSIGN", "ORDER_INTENT"],
    maxIterations: 12,
  }),
];

export const BUILTIN_AGENT_DEFINITION_IDS = new Set(
  SEED_AGENT_DEFINITIONS.map((d) => d.id)
);

export const BUILTIN_AGENT_ROLES = new Set(SEED_AGENT_DEFINITIONS.map((d) => d.role));

/** 已退役/合并的内置 definition id，seed 时禁用 */
export const RETIRED_BUILTIN_DEFINITION_IDS = [
  "def-researcher-bull",
  "def-researcher-bear",
  "def-backtest-engineer",
  "def-execution-trader",
  "def-memory-curator",
  "def-risk-manager",
  "def-simulation",
  "def-execution",
  "def-memory",
  "def-audit",
  "def-portfolio-manager",
  "def-stock-screener",
] as const;
