/**
 * 内置研究场景规格（11 个首发场景）
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.6.2 / §6.6.3 / §6.6.4
 *
 */

import type { ResearchScenarioSpec } from "./types";

const COMMON_UNIVERSE_ENUM = [
  { value: "CN-A:hs300", label: "A 股·沪深 300" },
  { value: "CN-A:csi500", label: "A 股·中证 500" },
  { value: "CN-A:csi1000", label: "A 股·中证 1000" },
  { value: "US:sp500", label: "美股·SP500" },
  { value: "US:nasdaq100", label: "美股·NASDAQ100" },
  { value: "HK:hsi", label: "港股·恒生指数" },
  { value: "Crypto:top50", label: "加密·Top50" },
] as const;

const FACTOR_CATEGORY_ENUM = [
  { value: "value", label: "价值" },
  { value: "momentum", label: "动量" },
  { value: "volatility", label: "波动" },
  { value: "news", label: "新闻/情绪" },
  { value: "quality", label: "质量" },
  { value: "macro", label: "宏观" },
] as const;

// ─── 1. 分析辩论（保留已有行为） ─────────────────────────────────────────────
export const ANALYST_DEBATE_SCENARIO: ResearchScenarioSpec = {
  key: "analyst_debate",
  displayName: "分析辩论（MSA + 多空）",
  description: "四维分析师 MSA 融合 + 多空辩论；产出综合信号。",
  inputSchema: {
    ticker: {
      type: "string",
      required: true,
      description: "标的代码（单标的或逗号分隔多标的）",
      group: "basic",
    },
    instrument: {
      type: "enum",
      values: [
        { value: "equity", label: "现货" },
        { value: "option", label: "期权" },
      ],
      default: "equity",
      group: "basic",
    },
    positionSide: {
      type: "enum",
      values: [
        { value: "long", label: "多头" },
        { value: "short", label: "做空" },
      ],
      default: "long",
      group: "basic",
    },
    debateRounds: {
      type: "number",
      default: 1,
      min: 0,
      max: 5,
      description: "多空辩论轮数（0=跳过）",
      group: "advanced",
    },
  },
  outputContract: { primary: "analyst_signal_fusion", secondary: ["debate_transcript"] },
  requiredCapabilities: [],
  toolPreset: {
    builtinTools: ["run_analyst_team", "fetch_bars", "fetch_news"],
    connectors: ["qubit-data", "qubit-news", "qubit-research"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 4, reactLoop: true, requireDebate: true, requireRiskVeto: false },
  status: "enabled",
  sortOrder: 10,
  isBuiltin: true,
};

// ─── 2. 策略撰写（保留已有行为） ─────────────────────────────────────────────
export const STRATEGY_AUTHORING_SCENARIO: ResearchScenarioSpec = {
  key: "strategy_authoring",
  displayName: "策略撰写（研究→回测→风控）",
  description: "基于上游研究结论或上下文，直接产出可回测策略。",
  inputSchema: {
    ticker: {
      type: "string",
      required: true,
      description: "标的代码",
      group: "basic",
    },
    strategyHint: {
      type: "string",
      description: "策略风格提示（可选，如『中长期趋势』）",
      group: "basic",
    },
    timeframe: {
      type: "enum",
      values: [
        { value: "1d", label: "日线" },
        { value: "60m", label: "60 分钟" },
        { value: "15m", label: "15 分钟" },
      ],
      default: "1d",
      group: "basic",
    },
  },
  outputContract: { primary: "strategy_script", secondary: ["backtest_metrics"] },
  requiredCapabilities: [
    { kind: "backtest", level: "required" },
  ],
  toolPreset: {
    builtinTools: ["fetch_bars", "run_backtest"],
    connectors: ["qubit-data", "qubit-backtest", "qubit-risk"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 6, reactLoop: true },
  status: "enabled",
  sortOrder: 20,
  isBuiltin: true,
};

// ─── 3. 因子研究 ────────────────────────────────────────────────────────────
export const FACTOR_RESEARCH_SCENARIO: ResearchScenarioSpec = {
  key: "factor_research",
  displayName: "因子研究",
  description: "围绕目标因子类别生成候选因子、计算因子值、评估 IC/IR、入库为可复用因子。",
  inputSchema: {
    universe: {
      type: "enum",
      values: COMMON_UNIVERSE_ENUM,
      default: "CN-A:hs300",
      required: true,
      group: "basic",
    },
    factorCategory: {
      type: "enum",
      values: FACTOR_CATEGORY_ENUM,
      default: "momentum",
      required: true,
      group: "basic",
    },
    lookbackDays: {
      type: "number",
      default: 504,
      min: 60,
      max: 2520,
      description: "回看窗口（交易日）",
      group: "basic",
    },
    horizonDays: {
      type: "number",
      default: 5,
      min: 1,
      max: 60,
      description: "预测周期（交易日）",
      group: "basic",
    },
    icThreshold: {
      type: "number",
      default: 0.03,
      min: 0.0,
      max: 1.0,
      step: 0.01,
      description: "入库门槛：IC 绝对值",
      group: "advanced",
    },
    seedExpressions: {
      type: "string[]",
      description: "种子表达式（可选）",
      group: "expert",
    },
  },
  outputContract: {
    primary: "factor_definition_batch",
    secondary: ["factor_evaluation_report", "discovery_job_summary"],
  },
  requiredCapabilities: [
    { kind: "factor_compute", level: "required" },
    { kind: "factor_eval", level: "required" },
  ],
  toolPreset: {
    builtinTools: ["factor.register", "factor.compute", "factor.evaluate"],
    connectors: ["qubit-data", "qubit-research"],
    mcpServers: [],
    defaultParams: { populationSize: 12, concurrency: 4 },
  },
  loopDefaults: { maxIterations: 6, reactLoop: true },
  status: "enabled",
  sortOrder: 30,
  isBuiltin: true,
};

// ─── 4. 规则研究 ────────────────────────────────────────────────────────────
export const RULE_RESEARCH_SCENARIO: ResearchScenarioSpec = {
  key: "rule_research",
  displayName: "规则研究",
  description: "基于现有因子库，生成可解释的 JSON-DSL 规则并入库。",
  inputSchema: {
    universe: {
      type: "enum",
      values: COMMON_UNIVERSE_ENUM,
      default: "CN-A:hs300",
      required: true,
      group: "basic",
    },
    ruleTheme: {
      type: "string",
      description: '规则主题（如"低估值高动量"）',
      required: true,
      group: "basic",
    },
    appliesTo: {
      type: "enum",
      values: [
        { value: "select", label: "选股" },
        { value: "filter", label: "过滤" },
        { value: "score", label: "打分" },
        { value: "order", label: "下单" },
        { value: "risk", label: "风控" },
      ],
      default: "score",
      group: "basic",
    },
    candidateFactorIds: {
      type: "string[]",
      description: "候选因子 ID 列表（缺省=场景自动挑选已 active 的因子）",
      group: "advanced",
    },
  },
  outputContract: {
    primary: "rule_definition_batch",
    secondary: ["rule_evaluation_report"],
  },
  requiredCapabilities: [
    { kind: "rule_engine", level: "required" },
    { kind: "factor_compute", level: "required" },
  ],
  toolPreset: {
    builtinTools: ["rule.register", "rule.evaluate", "factor.list"],
    connectors: ["qubit-research"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 4, reactLoop: true },
  status: "enabled",
  sortOrder: 40,
  isBuiltin: true,
};

// ─── 5. 选股研究 ────────────────────────────────────────────────────────────
export const STOCK_SCREENING_SCENARIO: ResearchScenarioSpec = {
  key: "stock_screening",
  displayName: "选股研究",
  description: "基于因子打分与规则过滤产出候选股池。",
  inputSchema: {
    universe: {
      type: "enum",
      values: COMMON_UNIVERSE_ENUM,
      default: "CN-A:csi500",
      required: true,
      group: "basic",
    },
    topN: {
      type: "number",
      default: 30,
      min: 5,
      max: 200,
      description: "候选数量",
      group: "basic",
    },
    factorIds: {
      type: "string[]",
      description: "参与打分的因子 ID（留空=自动选 IC>0.03 的因子）",
      group: "advanced",
    },
    ruleIds: {
      type: "string[]",
      description: "过滤规则 ID",
      group: "advanced",
    },
  },
  outputContract: { primary: "candidate_pool", secondary: ["selection_reasoning"] },
  requiredCapabilities: [
    { kind: "factor_compute", level: "required" },
    { kind: "rule_engine", level: "optional" },
  ],
  toolPreset: {
    builtinTools: ["factor.list", "rule.evaluate", "run_screener", "recommendation.record"],
    connectors: ["qubit-data", "qubit-research"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 3, reactLoop: true },
  status: "enabled",
  sortOrder: 50,
  isBuiltin: true,
};

// ─── 6. 风控审查 ────────────────────────────────────────────────────────────
export const RISK_REVIEW_SCENARIO: ResearchScenarioSpec = {
  key: "risk_review",
  displayName: "风控审查",
  description: "审查策略历史与现有限额，产出新的风控规则建议。",
  inputSchema: {
    targetStrategyId: {
      type: "string",
      description: "目标策略 ID（可选；为空=审查 project 级）",
      group: "basic",
    },
    rangeStart: {
      type: "string",
      description: "审查起始日期 YYYY-MM-DD",
      group: "basic",
    },
    rangeEnd: {
      type: "string",
      description: "审查结束日期 YYYY-MM-DD",
      group: "basic",
    },
    limitTypes: {
      type: "multi_enum",
      values: [
        { value: "max_notional", label: "单笔金额上限" },
        { value: "max_drawdown", label: "最大回撤" },
        { value: "concentration", label: "集中度" },
        { value: "kill_switch", label: "全局熔断" },
      ],
      default: ["max_notional", "max_drawdown"],
      group: "basic",
    },
  },
  outputContract: { primary: "rule_definition_batch", secondary: ["risk_audit_report"] },
  requiredCapabilities: [
    { kind: "rule_engine", level: "required" },
  ],
  toolPreset: {
    // NOTE: 暂无专门的「读取审计日志」builtin；用 load_rules 读当前规则配置代替
    // TODO: 后续如需 audit log 检索，新增 audit.query builtin（参考 builtin-tools.ts）
    builtinTools: ["rule.register", "rule.evaluate", "load_rules"],
    connectors: ["qubit-risk"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 4, reactLoop: true, requireRiskVeto: false },
  status: "enabled",
  sortOrder: 60,
  isBuiltin: true,
};

// ─── 7. PM 组合管理 ────────────────────────────────────────────────────────
export const PORTFOLIO_MANAGEMENT_SCENARIO: ResearchScenarioSpec = {
  key: "portfolio_management",
  displayName: "PM 组合管理",
  description: "多策略权重分配、再平衡方案、暴露报告。",
  inputSchema: {
    strategyIds: {
      type: "string[]",
      required: true,
      description: "纳入组合的策略 ID 列表",
      group: "basic",
    },
    riskBudget: {
      type: "number",
      default: 0.15,
      min: 0.02,
      max: 0.5,
      step: 0.01,
      description: "组合年化波动目标",
      group: "basic",
    },
    rebalanceFreq: {
      type: "enum",
      values: [
        { value: "1d", label: "每日" },
        { value: "5d", label: "每周" },
        { value: "20d", label: "每月" },
      ],
      default: "5d",
      group: "basic",
    },
    targetExposureJson: {
      type: "string",
      description: "目标暴露 JSON（行业/因子）",
      group: "expert",
    },
  },
  outputContract: {
    primary: "portfolio_allocation",
    secondary: ["exposure_report", "rebalance_plan"],
  },
  requiredCapabilities: [
    { kind: "factor_compute", level: "optional" },
    { kind: "backtest", level: "required" },
  ],
  toolPreset: {
    // NOTE: portfolio.optimize / portfolio.rebalance 尚未实装（FACTOR_RULE_STRATEGY_DESIGN.md §3.6 / P3）
    // 过渡：先用 compute_factors 看暴露 + run_backtest 跑历史；factor.list 选可用因子
    // TODO: P3 落地后切回 portfolio.optimize / portfolio.rebalance
    builtinTools: ["factor.list", "compute_factors", "run_backtest"],
    connectors: ["qubit-research", "qubit-backtest"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 5, reactLoop: true, requirePmApproval: true },
  status: "enabled",
  sortOrder: 70,
  isBuiltin: true,
};

// ─── 8. 因子/规则/策略 挖掘 ────────────────────────────────────────────────
export const DISCOVERY_SCENARIO: ResearchScenarioSpec = {
  key: "discovery",
  displayName: "因子/规则/策略 挖掘",
  description: "自动生成候选因子+规则+策略，演化筛选 Sharpe>阈值 的优胜者。",
  inputSchema: {
    universe: {
      type: "enum",
      values: COMMON_UNIVERSE_ENUM,
      default: "CN-A:hs300",
      required: true,
      group: "basic",
    },
    populationSize: {
      type: "number",
      default: 12,
      min: 4,
      max: 50,
      group: "basic",
    },
    generations: {
      type: "number",
      default: 5,
      min: 1,
      max: 20,
      group: "basic",
    },
    sharpeThreshold: {
      type: "number",
      default: 1.0,
      min: 0.0,
      max: 5.0,
      step: 0.1,
      group: "advanced",
    },
    earlyStopRounds: {
      type: "number",
      default: 3,
      min: 1,
      max: 10,
      description: "连续 N 代无提升则停止",
      group: "advanced",
    },
  },
  outputContract: {
    primary: "discovery_job_summary",
    secondary: ["factor_definition_batch", "rule_definition_batch", "strategy_composition_batch"],
  },
  requiredCapabilities: [
    { kind: "factor_compute", level: "required" },
    { kind: "factor_eval", level: "required" },
    { kind: "backtest", level: "required" },
  ],
  toolPreset: {
    // M4 已实装：discovery.run（alpha101 模板 / factor_gp 符号回归）+ discovery.promote
    // P0-4 增补：factor.mine.llm（LLM 一次产 N 个 + 评估闸门）
    // rule.mine.llm / discovery.evolve 留待 P3
    builtinTools: [
      "factor.mine.llm",
      "discovery.run",
      "discovery.promote",
      "factor.evaluate.batch",
      "backtest.run",
    ],
    connectors: ["qubit-research", "qubit-backtest"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 8, reactLoop: true },
  status: "enabled",
  sortOrder: 80,
  isBuiltin: true,
};

// ─── 9. 实盘交易 ────────────────────────────────────────────────────────────
export const LIVE_TRADING_SCENARIO: ResearchScenarioSpec = {
  key: "live_trading",
  displayName: "实盘交易",
  description: "实盘下单、监控、风控记录；走 Live 闸门。",
  inputSchema: {
    strategyId: {
      type: "string",
      required: true,
      description: "实盘运行的策略 ID",
      group: "basic",
    },
    brokerAccountId: {
      type: "string",
      required: true,
      description: "券商账号 ID",
      group: "basic",
    },
    capitalCap: {
      type: "number",
      default: 100000,
      min: 1000,
      description: "本次实盘资金上限",
      group: "basic",
    },
    killSwitchEnabled: {
      type: "boolean",
      default: true,
      description: "全局熔断开关",
      group: "basic",
    },
    confirmLevel: {
      type: "enum",
      values: [
        { value: "auto", label: "自动" },
        { value: "manual_each", label: "每单人工" },
        { value: "manual_first", label: "首单人工" },
      ],
      default: "manual_first",
      group: "basic",
    },
  },
  outputContract: { primary: "live_session_summary", secondary: ["risk_event_log"] },
  requiredCapabilities: [
    { kind: "rule_engine", level: "required" },
  ],
  toolPreset: {
    // 走 qubit-broker connector：submit_order / cancel_order / get_fills（tool-routes.ts）
    builtinTools: ["submit_order", "cancel_order", "get_fills", "rule.evaluate"],
    connectors: ["qubit-broker", "qubit-risk"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 12, reactLoop: true, requireRiskVeto: true },
  status: "enabled",
  sortOrder: 90,
  isBuiltin: true,
};

// ─── 10. 复盘归因 ──────────────────────────────────────────────────────────
export const POSTMORTEM_SCENARIO: ResearchScenarioSpec = {
  key: "postmortem",
  displayName: "复盘归因",
  description: "对一段时间或某策略的成交/持仓做因子归因、行业归因、事件归因。",
  inputSchema: {
    targetStrategyId: {
      type: "string",
      description: "目标策略 ID",
      group: "basic",
    },
    rangeStart: {
      type: "string",
      required: true,
      group: "basic",
    },
    rangeEnd: {
      type: "string",
      required: true,
      group: "basic",
    },
    attribDimensions: {
      type: "multi_enum",
      values: [
        { value: "factor", label: "因子" },
        { value: "industry", label: "行业" },
        { value: "event", label: "事件" },
        { value: "regime", label: "市场状态" },
      ],
      default: ["factor", "industry"],
      group: "basic",
    },
  },
  outputContract: { primary: "attribution_report" },
  requiredCapabilities: [
    { kind: "factor_compute", level: "required" },
  ],
  toolPreset: {
    builtinTools: ["factor.list", "get_fills", "fetch_bars"],
    connectors: ["qubit-data", "qubit-research"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 5, reactLoop: true },
  status: "enabled",
  sortOrder: 100,
  isBuiltin: true,
};

// ─── 11. 事件雷达 ──────────────────────────────────────────────────────────
export const NEWS_EVENT_RADAR_SCENARIO: ResearchScenarioSpec = {
  key: "news_event_radar",
  displayName: "事件雷达",
  description: "扫描新闻流，识别可交易事件，输出影响评估与预警。",
  inputSchema: {
    universe: {
      type: "enum",
      values: COMMON_UNIVERSE_ENUM,
      default: "CN-A:hs300",
      required: true,
      group: "basic",
    },
    keywords: {
      type: "string[]",
      description: "关键词（可选）",
      group: "basic",
    },
    eventTypes: {
      type: "multi_enum",
      values: [
        { value: "earnings", label: "财报" },
        { value: "guidance", label: "指引/预告" },
        { value: "ma", label: "并购" },
        { value: "regulatory", label: "监管" },
        { value: "macro", label: "宏观" },
      ],
      default: ["earnings", "guidance"],
      group: "basic",
    },
    horizonHours: {
      type: "number",
      default: 24,
      min: 1,
      max: 168,
      description: "扫描窗口（小时）",
      group: "advanced",
    },
  },
  outputContract: { primary: "event_radar_report", secondary: ["impact_alerts"] },
  requiredCapabilities: [],
  toolPreset: {
    builtinTools: ["fetch_news", "fetch_bars"],
    connectors: ["qubit-news", "qubit-data"],
    mcpServers: [],
    defaultParams: {},
  },
  loopDefaults: { maxIterations: 5, reactLoop: true },
  status: "enabled",
  sortOrder: 110,
  isBuiltin: true,
};

// ─── 全部内置场景 ──────────────────────────────────────────────────────────
export const BUILTIN_RESEARCH_SCENARIOS: readonly ResearchScenarioSpec[] = [
  ANALYST_DEBATE_SCENARIO,
  STRATEGY_AUTHORING_SCENARIO,
  FACTOR_RESEARCH_SCENARIO,
  RULE_RESEARCH_SCENARIO,
  STOCK_SCREENING_SCENARIO,
  RISK_REVIEW_SCENARIO,
  PORTFOLIO_MANAGEMENT_SCENARIO,
  DISCOVERY_SCENARIO,
  LIVE_TRADING_SCENARIO,
  POSTMORTEM_SCENARIO,
  NEWS_EVENT_RADAR_SCENARIO,
];
