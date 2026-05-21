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
  return {
    ...partial,
    /** 仅真实 MCP（mathjs / mcp-financex / 已启用的 fsi-*）；connector 走 tools 列表，勿写入 mcpServers */
    mcpServers: resolveSeedMcpServers(role, partial.mcpServers ?? []),
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
    /** 3.0.0：M9.P2 装上事件→因子链路（聚合 daily event_score 用） */
    version: "3.0.0",
    systemPrompt: PROMPT_NEWS_EVENT,
    tools: [
      "fetch_news",
      "fetch_news_sentiment",
      "extract_event",
      "score_sentiment",
      // M9.P2：把事件聚合成 daily event_score 时间序列
      "code.run_python",
      "call_mcp",
    ],
    maxIterations: 12,
  }),
  def({
    id: "def-analyst-fundamental",
    role: "analyst_fundamental",
    name: "基本面研究员",
    /** 3.0.0：M9.P2 装上量化锚点工具（factor.list value/quality + autoEvaluate + 沙箱） */
    version: "3.0.0",
    systemPrompt: PROMPT_ANALYST_FUNDAMENTAL,
    tools: [
      "fetch_financial_data",
      "fetch_fundamentals",
      "fetch_klines",
      "compute_valuation",
      "analyze_industry",
      // M9.P2：量化锚点 — 看现成价值/质量因子的 RankIC
      "factor.list",
      "factor.autoEvaluate",
      // M9.P2：沙箱 — DCF / 敏感度表 / 同业百分位
      "code.run_python",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 14,
  }),
  def({
    id: "def-analyst-technical",
    role: "analyst_technical",
    name: "量化策略师",
    /** 3.0.0：M9.P2 装上量化工坊全套（动量/反转/波动因子 + run_experiment + 沙箱） */
    version: "3.0.0",
    systemPrompt: PROMPT_ANALYST_TECHNICAL,
    tools: [
      "fetch_price_data",
      "fetch_klines",
      "compute_indicators",
      "detect_patterns",
      "run_backtest",
      // M9.P2：量化锚点 — 看现成动量/反转/波动因子的 RankIC
      "factor.list",
      "factor.autoEvaluate",
      "run_experiment",
      // M9.P2：沙箱 — RSI 截面排名、量价相关性
      "code.run_python",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 14,
  }),
  def({
    id: "def-analyst-sentiment",
    role: "analyst_sentiment",
    name: "舆情分析师",
    /** 3.0.0：M9.P2 装上事件→sentiment 因子工具（factor.register + autoEvaluate + 沙箱） */
    version: "3.0.0",
    systemPrompt: PROMPT_ANALYST_SENTIMENT,
    tools: [
      "fetch_news",
      "fetch_news_sentiment",
      "analyze_social_media",
      "get_analyst_ratings",
      "extract_event",
      "score_sentiment",
      // M9.P2：把事件聚合成情绪因子入库
      "factor.list",
      "factor.register",
      "factor.autoEvaluate",
      // M9.P2：沙箱 — 大批量新闻聚合 / 情绪 decay 曲线
      "code.run_python",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 14,
  }),
  def({
    id: "def-analyst-macro",
    role: "analyst_macro",
    name: "宏观策略师",
    /** 3.0.0：M9.P2 装上跨市场相关性 + regime 量化工具（factor.list macro + 沙箱） */
    version: "3.0.0",
    systemPrompt: PROMPT_ANALYST_MACRO,
    tools: [
      "fetch_macro_data",
      "fetch_klines",
      "analyze_policy",
      "compute_macro_indicators",
      // M9.P2：量化锚点 — 看现成宏观因子（如果项目里 promote 过）
      "factor.list",
      "factor.autoEvaluate",
      // M9.P2：沙箱 — 跨市场相关性矩阵 + regime 检测
      "code.run_python",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 14,
  }),
  def({
    id: "def-research",
    role: "research",
    name: "策略研究",
    /** 4.0.0：装齐 M2/M6 量化工坊全套工具，可在 chat 流程驱动「因子→评估→挖掘→promote→组合→回测」完整闭环 */
    version: "4.0.0",
    systemPrompt: PROMPT_RESEARCH,
    tools: [
      // 基础数据
      "fetch_klines",
      "compute_factors",
      "compute_indicators",
      // M2 因子三段式
      "factor.register",
      "factor.compute",
      "factor.evaluate",
      // M6.2 自动评估 + 挖掘 + 组合 + 回测一键
      "factor.list",
      "factor.autoEvaluate",
      "rule.register",
      "rule.evaluate",
      "strategy.compose",
      "discovery.run",
      "discovery.promote",
      "backtest.run",
      // M7.3 沙箱代码执行（拿大量数据做自由分析 / 算 IC 矩阵 / 算相关性等）
      "code.run_python",
      // 兼容旧链路
      "run_experiment",
      "version_strategy",
      "edit_agent_pack",
      "call_mcp",
    ],
    subscriptions: ["TASK_ASSIGN", "MODEL_UPDATE"],
    /** 因子研究迭代步数较多（list→evaluate→promote 多次） */
    maxIterations: 28,
  }),
  def({
    id: "def-backtest",
    role: "backtest",
    /** 4.0.0：装上事件驱动回测 backtest.run + 沙箱代码执行 */
    version: "4.0.0",
    name: "回测",
    systemPrompt: PROMPT_BACKTEST,
    tools: [
      "fetch_klines",
      "run_backtest",
      "get_backtest_status",
      "compute_indicators",
      // M2/M6 事件驱动回测
      "backtest.run",
      // 拉因子列表，配合 backtest.run 手写 signals
      "factor.list",
      "factor.compute",
      // 自由分析（如计算多回测同图 metrics、回归归因）
      "code.run_python",
      "call_mcp",
    ],
    maxIterations: 20,
  }),
  def({
    id: "def-risk",
    role: "risk",
    /** 4.0.0：可在 chat 中调用 rule.register/evaluate 直接生成入库风控规则 */
    version: "4.0.0",
    name: "风控",
    systemPrompt: PROMPT_RISK,
    tools: [
      "evaluate_risk",
      "sign_intent",
      "load_rules",
      "check_concentration",
      "assess_liquidity",
      // M2 规则三段式
      "rule.register",
      "rule.evaluate",
      // 沙箱：跑暴露 / 集中度 / VaR 计算
      "code.run_python",
    ],
    subscriptions: ["TASK_ASSIGN", "ORDER_INTENT"],
    maxIterations: 14,
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
