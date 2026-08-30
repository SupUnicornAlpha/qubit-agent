import { executionKindForRole } from "./prime/role-to-execution-kind";
import { ROLE_OUTPUTS, ROLE_SKILLS, resolveSeedMcpServers } from "./seed-agent-catalog";
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
  PROMPT_STRATEGY_CODER,
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
  | "executionKind"
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
      | "executionKind"
    >
  >;

function def(partial: SeedDefinition): RuntimeAgentDefinition {
  const role = partial.role;
  return {
    ...partial,
    executionKind: partial.executionKind ?? executionKindForRole(role),
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
 * - 专家 Agent 默认 ≤10 个官方 tool；行情 Agent 可额外拥有 14 个行情/期权取证工具
 * - Orchestrator 不设上限：持有场景合同写工具 + 派单 + 记忆/skill
 * - 行情治理工具只留给 market_data（或 Orchestrator 做 readiness 探活）
 */
const MARKET_GOVERNANCE_TOOLS = [
  "market.resolve_symbol",
  "market.data_sources",
  "market.readiness",
  "market.snapshot.get",
] as const;

/** 内置 Agent 定义：Orchestrator + 数据/新闻 + 四维分析师 + 研究/回测/风控 */
export const SEED_AGENT_DEFINITIONS: RuntimeAgentDefinition[] = [
  def({
    id: "def-orchestrator",
    role: "orchestrator",
    name: "编排器",
    /**
     * 4.3.0：Cursor/Codex 式 subagent 纪律 —— 一次派单、结构化 handoff、父代理合成；
     * 禁止对同专家盲重试同一 goal；空信封必须收口标注缺口。
     */
    version: "4.3.1",
    systemPrompt: PROMPT_ORCHESTRATOR,
    tools: [
      // 编排
      "update_plan",
      "agent.invoke",
      // Prime HOST 证据链（D2–D5）
      "market.ide_subscription.get",
      "market.broker_quote.get",
      "market.resolve_symbol",
      "market.snapshot.get",
      "research.thesis.write",
      "research.forecast_book.get",
      "portfolio.construct",
      "order.create_intent",
      // 场景合同写（主责）
      "run_screener",
      "recommendation.record",
      "factor.register",
      "discovery.run",
      "discovery.promote",
      "strategy.create_version",
      "strategy.compose",
      "strategy.compile",
      "strategy.contract_backtest",
      "strategy.paper_deploy",
      "strategy.paper_run",
      "strategy.sim_deploy",
      "backtest.run",
      "evaluate_risk",
      "rule.register",
      // 记忆 / skill / 逃生舱
      "memory.recall",
      "memory.consolidate_longterm",
      "memory.refresh_workspace",
      "tool.catalog.search",
      "skill.search",
      "skill.use_record",
      "skill.create",
      "skill.patch",
      "skill.archive",
      // 官方联网（研究默认；不可作实盘行情源）
      "web.search",
      "web.fetch",
    ],
    subscriptions: ["TASK_ASSIGN", "TASK_RESULT", "ALERT", "RISK_BLOCK"],
    maxIterations: 12,
  }),
  def({
    id: "def-execution-monitor",
    role: "execution",
    name: "执行监控",
    /** 1.0.0：严格只读的 broker 账户、订单、对账与 kill-switch 观察面。 */
    version: "1.0.0",
    executionKind: "reactor",
    systemPrompt:
      "你是执行监控 Agent。只读取券商账户、订单、成交、持仓、对账和熔断状态；" +
      "绝不创建、取消、修改订单，也不绕过风险签名或人工确认。发现对账差异、账户停机或能力缺口时，" +
      "输出可审计的结构化告警、影响范围和人工处理建议。",
    tools: [
      "execution.account.snapshot",
      "execution.order.get",
      "order.list_open",
      "provider.capabilities",
      "execution.reconcile.positions",
      "execution.kill_switch.status",
      "tool.catalog.search",
      "skill.search",
      "skill.use_record",
    ],
    subscriptions: ["ALERT", "RISK_BLOCK", "ORDER_INTENT", "TASK_ASSIGN"],
    maxIterations: 4,
  }),
  def({
    id: "def-market-data",
    role: "market_data",
    name: "行情数据",
    /** 2.7.0：行情取证 + 微观结构（ticks/order book/trades/chip）唯一归行情 Agent。 */
    version: "2.11.0",
    systemPrompt: PROMPT_MARKET_DATA,
    tools: [
      ...MARKET_GOVERNANCE_TOOLS,
      "fetch_klines",
      "fetch_quote",
      "fetch_option_chain",
      "market.options.strategy_analyze",
      "fetch_ticks",
      "fetch_order_book",
      "fetch_trades",
      "fetch_chip_distribution",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 5,
  }),
  def({
    id: "def-news-event",
    role: "news_event",
    name: "新闻事件",
    /**
     * 3.5.3：专用 recipe=`news` 收紧工具面（无 investor-agent MCP / call_team）。
     * Core bridge 暴露 fetch_news*；失败文案禁止 [object Object]。
     */
    version: "3.5.3",
    executionKind: "subagent",
    systemPrompt: PROMPT_NEWS_EVENT,
    tools: ["fetch_news", "fetch_news_sentiment", "web.search", "skill.search", "skill.use_record"],
    maxIterations: 4,
  }),
  def({
    id: "def-analyst-fundamental",
    role: "analyst_fundamental",
    name: "基本面研究员",
    /**
     * 3.6.1：补齐财务数据 fallback；真实估值字段优先 investor-agent MCP。
     * 禁止自拉 klines——行情由 market_data 提供。
     */
    version: "3.7.0",
    systemPrompt: PROMPT_ANALYST_FUNDAMENTAL,
    tools: [
      "fetch_fundamentals",
      "compute_valuation",
      "math.derivation.verify",
      "research.thesis.write",
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
    /** 3.6.0：K 线 + 指标 + 形态 + 结构化 thesis。 */
    version: "3.6.0",
    systemPrompt: PROMPT_ANALYST_TECHNICAL,
    tools: [
      "fetch_klines",
      "compute_indicators",
      "detect_patterns",
      "research.thesis.write",
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
    /** 3.6.0：新闻证据 + 结构化 thesis；注册因子交给编排器/research。 */
    version: "3.6.0",
    systemPrompt: PROMPT_ANALYST_SENTIMENT,
    tools: [
      "fetch_news",
      "fetch_news_sentiment",
      "research.thesis.write",
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
    /** 3.6.0：宏观指标 + 必要跨市场 K 线 + 结构化 thesis。 */
    version: "3.6.0",
    systemPrompt: PROMPT_ANALYST_MACRO,
    tools: [
      "fetch_klines",
      "compute_macro_indicators",
      "research.thesis.write",
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
     * 4.6.0：因子→策略→回测主链 + 数学推导审计（恰 10）。
     * 官方联网由 resolveEffectiveTools 自动附加 INTERNET_SUPPORT_TOOLS。
     * discovery / 推荐落库 / 下单由 Orchestrator 主责。
     */
    version: "4.6.0",
    systemPrompt: PROMPT_RESEARCH,
    tools: [
      "factor.register",
      "factor.compute",
      "factor.autoEvaluate",
      "factor.list",
      "math.derivation.verify",
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
    /** 4.15.0：最终独立 holdout 是 live 晋级前的单次保留验证。 */
    version: "4.15.0",
    name: "回测",
    systemPrompt: PROMPT_BACKTEST,
    tools: [
      "backtest.run",
      "backtest.walk_forward",
      "backtest.final_holdout",
      "factor.list",
      "factor.compute",
      "fetch_klines",
      "code.run_python",
      "math.derivation.verify",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 8,
  }),
  def({
    id: "def-risk",
    role: "risk",
    /** 4.4.0：签核本职 + 数学审计；不再挂行情/MCP。 */
    version: "4.4.0",
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
      "math.derivation.verify",
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
    version: "1.7.0",
    systemPrompt: PROMPT_WALK_FORWARD_VALIDATOR,
    tools: [
      "backtest.run",
      "backtest.walk_forward",
      "backtest.final_holdout",
      "factor.list",
      "factor.autoEvaluate",
      "factor.evaluate.batch",
      "code.run_python",
      "math.derivation.verify",
      "skill.search",
      "skill.use_record",
    ],
    maxIterations: 10,
  }),
  def({
    id: "def-strategy-coder",
    role: "research",
    name: "策略编码验证",
    /**
     * Prime 06 — on-demand subagent（不进 grp-strategy-pipeline 固定成员）。
     * Orchestrator: agent.invoke({ callee_spec_id: "def-strategy-coder", goal })
     * 画布：Core 投影后以 strategy_coder 节点入图（idle 不展示）。
     * 勿用 call_team_research（会绑到 def-research）。
     */
    version: "1.1.0",
    executionKind: "subagent",
    systemPrompt: PROMPT_STRATEGY_CODER,
    tools: [
      "strategy.compile",
      "strategy.contract_backtest",
      "strategy.paper_deploy",
      "strategy.paper_run",
      "strategy.sim_deploy",
      "strategy.create_version",
      "code.run_python",
      "math.derivation.verify",
      "skill.search",
      "skill.use_record",
    ],
    subscriptions: ["TASK_ASSIGN", "MODEL_UPDATE"],
    maxIterations: 10,
  }),
];

export const BUILTIN_AGENT_DEFINITION_IDS = new Set(SEED_AGENT_DEFINITIONS.map((d) => d.id));

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
