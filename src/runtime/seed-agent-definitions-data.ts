import type { RuntimeAgentDefinition } from "./types";
import {
  ROLE_CONNECTOR_MCPS,
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

function def(
  partial: RuntimeAgentDefinition & { enabled?: boolean }
): RuntimeAgentDefinition {
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
    /**
     * 3.5.0（2026-06）：把 MSA 后的"裸 LLM 决策汇总"拆成 builtin tool
     * `summarize_team_decision`，由 Orchestrator 在 ReAct loop 中按需调用，
     * 不再每个 workflow 强制 +1 次 LLM 延迟。
     */
    version: "3.5.0",
    systemPrompt: PROMPT_ORCHESTRATOR,
    tools: [
      "assign_task",
      "run_analyst_team",
      /**
       * 2026-06：原 `runAnalystTeam` 内部强制跑的"裸 LLM 决策汇总"拆成本工具，由
       * Orchestrator 在 ReAct 中按需调（典型条件：fusedConfidence<0.6 / 信号分歧 / 签到不全）。
       * 详见 system prompt「研究团队工具结果处理」段。
       */
      "summarize_team_decision",
      "fuse_signals",
      "evaluate_risk",
      "edit_agent_pack",
      // M10.A2：playbook 复用 + postmortem 沉淀
      "search_memory",
      "memory.consolidate_longterm",
      "memory.refresh_workspace",
      // M11：程序性记忆全套（与 SKILLS_NUDGE 提示词自洽）
      "skill.search",
      "skill.use_record",
      "skill.create",
      "skill.patch",
      "skill.archive",
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
      // M9.P2：量化锚点 — 看现成价值/质量因子的 RankIC
      "factor.list",
      "factor.autoEvaluate",
      // M9.P2：沙箱 — DCF / 敏感度表 / 同业百分位
      "code.run_python",
      // M11：程序性记忆（复用历史 skill 流程 + 记录用量）
      "skill.search",
      "skill.use_record",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 14,
  }),
  def({
    id: "def-analyst-technical",
    role: "analyst_technical",
    name: "量化策略师",
    /**
     * 3.0.0：M9.P2 装上量化工坊全套（动量/反转/波动因子 + run_experiment + 沙箱）。
     * 3.1.0：评估报告 P2-E — 去掉 `run_backtest` 工具授权。
     *
     *   原因：PROMPT_ANALYST_TECHNICAL（seed-agent-prompts.ts:528）明确写
     *   "信号 > 0.7 即触发 backtest 外抛"——technical 只产因子/规则信号，
     *   不亲自跑回测；保留 run_backtest 会让 LLM 误把 backtest 作为本角色
     *   职责吞掉一轮迭代，token 浪费 + 与 backtest 角色重复（参见调研：
     *   3 个 def 的工具集中 run_backtest 唯一可去重的 1 个）。
     */
    version: "3.1.0",
    systemPrompt: PROMPT_ANALYST_TECHNICAL,
    tools: [
      "fetch_price_data",
      "fetch_klines",
      "compute_indicators",
      "detect_patterns",
      // M9.P2：量化锚点 — 看现成动量/反转/波动因子的 RankIC
      "factor.list",
      "factor.autoEvaluate",
      "run_experiment",
      // M9.P2：沙箱 — RSI 截面排名、量价相关性
      "code.run_python",
      // M11：程序性记忆（复用历史 skill 流程 + 记录用量）
      "skill.search",
      "skill.use_record",
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
      "extract_event",
      "score_sentiment",
      // M9.P2：把事件聚合成情绪因子入库
      "factor.list",
      "factor.register",
      "factor.autoEvaluate",
      // M9.P2：沙箱 — 大批量新闻聚合 / 情绪 decay 曲线
      "code.run_python",
      // M11：程序性记忆（复用历史 skill 流程 + 记录用量）
      "skill.search",
      "skill.use_record",
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
      "fetch_klines",
      "compute_macro_indicators",
      // M9.P2：量化锚点 — 看现成宏观因子（如果项目里 promote 过）
      "factor.list",
      "factor.autoEvaluate",
      // M9.P2：沙箱 — 跨市场相关性矩阵 + regime 检测
      "code.run_python",
      // M11：程序性记忆（复用历史 skill 流程 + 记录用量）
      "skill.search",
      "skill.use_record",
      "edit_agent_pack",
      "call_mcp",
    ],
    maxIterations: 14,
  }),
  def({
    id: "def-research",
    role: "research",
    name: "策略研究",
    /** 4.0.0：装齐 M2/M6 量化工坊全套工具；4.1.0：长期记忆使用规约（M10.A2）— factor_archive/playbook 复用 + consolidation */
    version: "4.1.0",
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
      // M10.A2 长期记忆 — factor_archive / playbook 复用 + 主动 consolidate
      "search_memory",
      "memory.consolidate_longterm",
      "memory.refresh_workspace",
      // M11：程序性记忆全套（与 SKILLS_NUDGE 提示词自洽）
      "skill.search",
      "skill.use_record",
      "skill.create",
      "skill.patch",
      "skill.archive",
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
      // M11：程序性记忆全套（与 SKILLS_NUDGE 提示词自洽）
      "skill.search",
      "skill.use_record",
      "skill.create",
      "skill.patch",
      "skill.archive",
      "call_mcp",
    ],
    maxIterations: 20,
  }),
  def({
    id: "def-risk",
    role: "risk",
    /**
     * 4.1.0：补 fetch_klines 工具授权。
     *
     * 之前 risk 在 strategy-pipeline 末端跑时 thought 反复说"本角色的授权工具集
     * 中没有任何行情/查询工具（无 fetch_klines、无 search_asset）"——只能拉规则
     * 就 stopped，无法独立验证标的真实性、估算波动率、跑 VaR / Stress Test
     * 所需的历史 pnl 序列。
     *
     * 现在加入 fetch_klines：风控角色仍以"签核 / 否决"为主，但允许它在数据
     * 不足时主动拉单标的日线，自行估算波动率分位 / 流动性 / 尾部风险，
     * 输出更可执行的 conditional 条件。
     */
    version: "4.1.0",
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
      /**
       * 4.1.0 新增：行情数据查询。让 risk 在 portfolio pnl 序列缺失时也能
       * 主动拉单标的日线、自行估算历史波动率 + VaR，避免"无数据就不出意见"。
       */
      "fetch_klines",
      // M11：程序性记忆全套（与 SKILLS_NUDGE 提示词自洽）
      "skill.search",
      "skill.use_record",
      "skill.create",
      "skill.patch",
      "skill.archive",
    ],
    subscriptions: ["TASK_ASSIGN", "ORDER_INTENT"],
    maxIterations: 14,
  }),
  /**
   * M9.P5：专项 Walk-Forward / Regime 验证 Agent，复用 backtest_engineer role
   * （在 RETIRED_BUILTIN_DEFINITION_IDS 里复活，因为 walk-forward 与一般 backtest 关注点不同）
   */
  def({
    id: "def-walk-forward-validator",
    role: "backtest_engineer",
    name: "Walk-Forward 验证师",
    version: "1.0.0",
    systemPrompt: PROMPT_WALK_FORWARD_VALIDATOR,
    tools: [
      // 多次跑回测（不同区间 / symbols）
      "backtest.run",
      "run_backtest",
      "get_backtest_status",
      // 看现成因子 RankIC 做 cross-section check
      "factor.list",
      "factor.autoEvaluate",
      "factor.evaluate.batch",
      // 拉行情做 regime detection
      "fetch_klines",
      // 沙箱：跨段比对 / Fama-French 归因 / Realized vol
      "code.run_python",
      // M11：程序性记忆（复用历史 skill 流程 + 记录用量）
      "skill.search",
      "skill.use_record",
      "call_mcp",
    ],
    /** Walk-forward 至少跑 3 段，每段独立 backtest.run → 工具调用轮数较多 */
    maxIterations: 24,
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
