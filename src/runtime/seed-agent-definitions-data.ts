import {
  ROLE_OUTPUTS,
  ROLE_SKILLS,
  resolveSeedMcpServers,
} from "./seed-agent-catalog";
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
  PROMPT_WALK_FORWARD_VALIDATOR,
} from "./seed-agent-prompts";
import type { RuntimeAgentDefinition } from "./types";

type SeedDefinition = Omit<
  RuntimeAgentDefinition,
  | "mcpServers"
  | "skills"
  | "outputs"
  | "subscriptions"
  | "llmProvider"
  | "maxIterations"
  | "sandboxPolicyId"
  | "enabled"
> &
  Partial<
    Pick<
      RuntimeAgentDefinition,
      | "mcpServers"
      | "skills"
      | "outputs"
      | "subscriptions"
      | "llmProvider"
      | "maxIterations"
      | "sandboxPolicyId"
      | "enabled"
    >
  >;

function def(partial: SeedDefinition): RuntimeAgentDefinition {
  const role = partial.role;
  return {
    ...partial,
    /** 仅真实 MCP（mathjs / mcp-financex / 已启用的 fsi-*）；connector 走 tools 列表，勿写入 mcpServers */
    mcpServers: resolveSeedMcpServers(role, partial.mcpServers ?? []),
    skills: partial.skills ?? ROLE_SKILLS[role] ?? [],
    /**
     * 产出能力（migration 0073）。未显式传时按 role 走 ROLE_OUTPUTS 默认；
     * 老 def 不传时默认 `[]`（dispatcher 走 role-name 老 fallback，保持兼容）。
     */
    outputs: partial.outputs ?? ROLE_OUTPUTS[role] ?? [],
    subscriptions: partial.subscriptions ?? ["TASK_ASSIGN"],
    llmProvider: partial.llmProvider ?? "",
    maxIterations: partial.maxIterations ?? 10,
    sandboxPolicyId: partial.sandboxPolicyId ?? "default-policy",
    enabled: partial.enabled ?? true,
  };
}

/**
 * 2026-08-04 精品工具面：
 * - 专家 Agent 默认 ≤10 个官方 tool，本职能力独占
 * - Orchestrator 不设上限：持有场景合同写工具 + 派单 + 记忆/skill
 * - 行情治理工具只留给 market_data（或 Orchestrator 做 readiness 探活）
 */
const MARKET_GOVERNANCE_TOOLS = [
  "market.resolve_symbol",
  "market.data_sources",
  "market.readiness",
] as const;

/** 内置 Agent 定义：Orchestrator + 数据/新闻 + 四维分析师 + 研究/回测/风控 */
export const SEED_AGENT_DEFINITIONS: RuntimeAgentDefinition[] = [
  def({
    id: "def-orchestrator",
    role: "orchestrator",
    name: "编排器",
    /**
     * 3.9.0（2026-08-04）：合同写权限集中到编排器；专家只保留领域精品工具。
     * 派单优先 call_team_* / assign_task；本角色直接落 recommendation / factor /
     * strategy / order 合同，避免「专家空转行情、合同永远不写」。
     */
    version: "3.9.0",
    systemPrompt: PROMPT_ORCHESTRATOR,
    tools: [
      // 编排
      "update_plan",
      "assign_task",
      "market.resolve_symbol",
      "market.readiness",
      // 场景合同写（主责）
      "run_screener",
      "recommendation.record",
      "factor.list",
      "factor.register",
      "factor.evaluate",
      "factor.autoEvaluate",
      "discovery.run",
      "discovery.promote",
      "strategy.create_version",
      "strategy.compose",
      "backtest.run",
      "order.create_intent",
      "evaluate_risk",
      "rule.register",
      "rule.evaluate",
      // 记忆 / skill / 逃生舱
      "search_memory",
      "memory.consolidate_longterm",
      "memory.refresh_workspace",
      "skill.search",
      "skill.use_record",
      "skill.create",
      "skill.patch",
      "skill.archive",
      "call_mcp",
    ],
    subscriptions: ["TASK_ASSIGN", "TASK_RESULT", "ALERT", "RISK_BLOCK"],
    maxIterations: 12,
  }),
  def({
    id: "def-market-data",
    role: "market_data",
    name: "行情数据",
    /** 2.5.0：只保留取证五件套；ticks/snapshot/MCP 外移。 */
    version: "2.5.0",
    systemPrompt: PROMPT_MARKET_DATA,
    tools: [
      ...MARKET_GOVERNANCE_TOOLS,
      "fetch_klines",
      "fetch_quote",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 5,
  }),
  def({
    id: "def-news-event",
    role: "news_event",
    name: "新闻事件",
    /** 3.3.0：新闻双件套 + 最小 skill。 */
    version: "3.3.0",
    systemPrompt: PROMPT_NEWS_EVENT,
    tools: [
      "fetch_news",
      "fetch_news_sentiment",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 5,
  }),
  def({
    id: "def-analyst-fundamental",
    role: "analyst_fundamental",
    name: "基本面研究员",
    /**
     * 3.5.0：本职=财报/估值。禁止自拉 klines——行情由 market_data 提供。
     */
    version: "3.5.0",
    systemPrompt: PROMPT_ANALYST_FUNDAMENTAL,
    tools: [
      "fetch_fundamentals",
      "compute_valuation",
      "code.run_python",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 6,
  }),
  def({
    id: "def-analyst-technical",
    role: "analyst_technical",
    name: "量化策略师",
    /** 3.5.0：K 线 + 指标 + 形态 + 最小 skill。 */
    version: "3.5.0",
    systemPrompt: PROMPT_ANALYST_TECHNICAL,
    tools: [
      "fetch_klines",
      "compute_indicators",
      "detect_patterns",
      "code.run_python",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 6,
  }),
  def({
    id: "def-analyst-sentiment",
    role: "analyst_sentiment",
    name: "舆情分析师",
    /** 3.5.0：只读新闻证据并解读；注册因子交给编排器/research。 */
    version: "3.5.0",
    systemPrompt: PROMPT_ANALYST_SENTIMENT,
    tools: [
      "fetch_news",
      "fetch_news_sentiment",
      "code.run_python",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 6,
  }),
  def({
    id: "def-analyst-macro",
    role: "analyst_macro",
    name: "宏观策略师",
    /** 3.5.0：宏观指标 + 必要跨市场 K 线。 */
    version: "3.5.0",
    systemPrompt: PROMPT_ANALYST_MACRO,
    tools: [
      "fetch_klines",
      "compute_macro_indicators",
      "code.run_python",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 6,
  }),
  def({
    id: "def-research",
    role: "research",
    name: "策略研究",
    /**
     * 4.5.0：因子→策略→回测主链 + 最小 skill（恰 10）。
     * discovery / 推荐落库 / 下单由 Orchestrator 主责。
     */
    version: "4.5.0",
    systemPrompt: PROMPT_RESEARCH,
    tools: [
      "factor.register",
      "factor.compute",
      "factor.evaluate",
      "factor.list",
      "factor.autoEvaluate",
      "strategy.create_version",
      "strategy.compose",
      "backtest.run",
      "skill.search",
      "skill.use_record",
    ],
    subscriptions: ["TASK_ASSIGN", "MODEL_UPDATE"],
    maxIterations: 10,
  }),
  def({
    id: "def-backtest",
    role: "backtest",
    /** 4.3.0：回测主路径 + 最小 skill；全套 skill 编辑仍在编排器。 */
    version: "4.3.0",
    name: "回测",
    systemPrompt: PROMPT_BACKTEST,
    tools: [
      "backtest.run",
      "run_backtest",
      "get_backtest_status",
      "factor.list",
      "factor.compute",
      "fetch_klines",
      "code.run_python",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 8,
  }),
  def({
    id: "def-risk",
    role: "risk",
    /** 4.3.0：签核本职 + 最小 skill；不再挂行情/MCP。 */
    version: "4.3.0",
    name: "风控",
    systemPrompt: PROMPT_RISK,
    tools: [
      "evaluate_risk",
      "sign_intent",
      "load_rules",
      "check_concentration",
      "assess_liquidity",
      "rule.register",
      "rule.evaluate",
      "skill.search",
      "skill.use_record",
    ],
    subscriptions: ["TASK_ASSIGN", "ORDER_INTENT"],
    maxIterations: 6,
  }),
  def({
    id: "def-walk-forward-validator",
    role: "backtest_engineer",
    name: "Walk-Forward 验证师",
    version: "1.2.0",
    systemPrompt: PROMPT_WALK_FORWARD_VALIDATOR,
    tools: [
      "backtest.run",
      "get_backtest_status",
      "factor.list",
      "factor.autoEvaluate",
      "factor.evaluate.batch",
      "code.run_python",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 10,
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
  /** M9.P5: def-backtest-engineer 已退役，但 backtest_engineer role 被 def-walk-forward-validator 复用 */
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
