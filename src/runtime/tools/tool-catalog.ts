import {
  isTopologyTeamTool,
  parseRoleFromTopologyTeamTool,
  topologyTeamToolDescription,
} from "../orchestration/topology-dispatch";
import { listRegisteredBuiltinTools } from "./builtin-tools";
import { TOOL_CONNECTOR_ROUTES } from "./tool-routes";
import type { ToolCatalogCategory, ToolCatalogEntry, ToolLifecycle } from "./types";

type ToolMetaEntry = {
  description: string;
  category: ToolCatalogCategory;
  lifecycle?: ToolLifecycle;
  replacedBy?: string;
  deprecationReason?: string;
  /**
   * When lifecycle=deprecated: if false, keep the original tool name on dispatch
   * (UI-only sunset). Default true = transparent alias to replacedBy.
   */
  resolveAlias?: boolean;
};

/** 工具分类（配置中心 hover / 筛选） */
export const TOOL_CATALOG_CATEGORIES: Record<ToolCatalogCategory, { label: string; hint: string }> =
  {
    orchestration: {
      label: "编排协作",
      hint: "任务拆解、派单、团队分析、信号融合",
    },
    market: { label: "行情数据", hint: "K 线、Tick、快照、财务数据代理" },
    research: { label: "量化研究", hint: "因子、指标、形态、估值、实验" },
    backtest: { label: "回测验证", hint: "历史回测与任务状态查询" },
    trading: { label: "交易执行", hint: "下单、撤单、成交、纸交易" },
    risk: { label: "风控合规", hint: "风险评估、签核、集中度与流动性" },
    sentiment: { label: "舆情事件", hint: "新闻、情绪、事件抽取" },
    macro: { label: "宏观策略", hint: "宏观指标与政策框架" },
    memory: { label: "记忆知识", hint: "跨会话记忆读写" },
    audit: { label: "审计报告", hint: "留痕与报告生成" },
    exec: { label: "命令执行", hint: "本地 CLI 工具 + 外部 agentic CLI 子代理" },
  };

/**
 * Removed from the global/model-visible surface. Dispatch aliases may remain
 * temporarily so persisted Agent definitions can migrate without breaking an
 * in-flight workflow, but new Agents and the global benchmark cannot select
 * these duplicate, stub or superseded names.
 */
export const RETIRED_GLOBAL_TOOL_NAMES = new Set([
  "call_mcp",
  "assign_task",
  "run_analyst_team",
  "summarize_team_decision",
  "fuse_signals",
  "check_risk",
  "fetch_bars",
  "fetch_price_data",
  "fetch_financial_data",
  "compute_factors",
  "run_experiment",
  "version_strategy",
  "factor.evaluate",
  "fetch_macro_data",
  "run_backtest",
  "get_backtest_status",
  "strategy.verify",
  "search_memory",
  "extract_event",
  "score_sentiment",
  "analyze_social_media",
  "cleanup_ttl",
]);

export function isRetiredGlobalToolName(name: string): boolean {
  return RETIRED_GLOBAL_TOOL_NAMES.has(name.trim());
}

const TOOL_META: Record<string, ToolMetaEntry> = {
  // 编排
  "tool.catalog.search": {
    description:
      "按名称、描述或类别搜索全局 Tool Catalog，并标明当前 Agent 是否已配置该工具。" +
      "它只做发现，不改变授权；用户可在 Agent 配置中绑定搜索结果。params: query?, category?, limit?。",
    category: "orchestration",
  },
  update_plan: {
    description:
      "更新对用户可见的分步计划/TODO（params: steps=[{id?,title,status?,note?}], successCriteria?:string[], constraints?:string[]；status∈pending|in_progress|done|skipped）。Goal 开工前先写可验证的完成标准和 3-5 步计划，每完成一步就更新状态；skipped 必须写原因。",
    category: "orchestration",
  },
  "web.fetch": {
    description:
      "读取公开网页正文（params: url, maxChars?）。只读 http/https；返回 title/finalUrl/text，source=web。" +
      "**何时用**：已知 URL（研报/公告/新闻链）补定性证据。未知 URL 先 web.search。" +
      "**不是实盘行情**：价格/K 线请 market.snapshot.get 或派 call_team_market_data；长新闻流派 call_team_news_event。",
    category: "research",
  },
  "web.search": {
    description:
      "公开网页搜索（params: query, count?≤10）。返回 title/url/snippet，source=web（DuckDuckGo；可配 WEB_SEARCH_PROVIDER）。" +
      "**研究默认联网入口**：查公司新闻/政策/事件线索 → 再 web.fetch 读正文。" +
      "批量/结构化新闻流请派 call_team_news_event（fetch_news）；不可替代行情源。",
    category: "research",
  },
  assign_task: {
    description:
      "向指定角色 Agent 派发任务（params: role, goal, …）。" +
      "行情/K线→market_data；新闻流→news_event；基本面/技术/舆情/宏观→对应 analyst_*；回测工程→backtest；风控→risk。" +
      "编排器自己用 web.search/web.fetch 做轻量联网检索，不要假装 fetch_klines/fetch_news。",
    category: "orchestration",
  },
  run_analyst_team: {
    description:
      "[Deprecated] 兼容性团队批量研究入口。Prime D6 起退出 Orchestrator 默认表面；请用 assign_task / call_team_<role>，再走 snapshot→thesis→portfolio→intent。",
    category: "orchestration",
    lifecycle: "deprecated",
    replacedBy: "assign_task",
    deprecationReason:
      "Prime D6：单 Agent 经 Tool Host 证据链收口；团队批量入口仅保留 handler 供旧桥对照，不透明 alias",
    resolveAlias: false,
  },
  summarize_team_decision: {
    description:
      "[Deprecated] 对 run_analyst_team 结果做全局兜底总结。Prime D6 起退出默认表面；改由 Orchestrator 自行整合专家结论。",
    category: "orchestration",
    lifecycle: "deprecated",
    replacedBy: "assign_task",
    deprecationReason: "Prime D6：团队批量总结不再挂在单 Agent 表面",
    resolveAlias: false,
  },
  fuse_signals: {
    description:
      "[Deprecated] 合并多分析师 buy/sell/hold 信号。Prime D6 起改用 research.thesis.write 结构化收口。",
    category: "orchestration",
    lifecycle: "deprecated",
    replacedBy: "research.thesis.write",
    deprecationReason: "Prime D6：信号融合由 thesis / portfolio 证据链替代",
    resolveAlias: false,
  },
  check_risk: {
    description: "编排链路中的风控检查（调用 qubit-risk）",
    category: "orchestration",
    lifecycle: "deprecated",
    replacedBy: "evaluate_risk",
    deprecationReason: "与 evaluate_risk 编排重复，统一走规范风控入口",
  },
  edit_agent_pack: {
    description: "编辑本 Agent 的 soul/user/memory/prompt 文件",
    category: "orchestration",
  },
  call_mcp: {
    description:
      "调用**已启用**的 MCP server 工具（params: serverName, mcpTool/toolName, arguments）。" +
      "**禁止**把 qubit-data / qubit-news / qubit-backtest 等内置 connector 名当作 serverName——" +
      "行情用 market.snapshot.get；新闻请派 call_team_news_event。仅用 mathjs / investor-agent / fsi-* 等已启用 MCP。",
    category: "orchestration",
  },
  run_screener: {
    description:
      "**探索类任务首选 — 按 sector / industry / 估值 / 动量等多维度筛真实股票候选**。" +
      "Universe 池含 200+ ticker（US S&P/NDX 头部 + CN-A 沪深300 头部 + HK 恒指/恒科 + Crypto），" +
      "返回 top-N 候选含 score 与 sector/industry/country meta。" +
      "`universe` 取值：`'ALL'`（默认，最不挑剔）/ `'US'` / `'CN-A'` / `'HK'` / `'CRYPTO'`。" +
      "`criteria` 可选：`{sector?, industry?, country?, minMarketCapBillion?, maxPe?, minMomentum30d?, minQuality?, minSentiment?}`，" +
      "**sector 取值**：Tech / Financials / Healthcare / Consumer / Energy / Industrials / Materials / REIT / Utilities / Telecom / Crypto；" +
      "**industry 用子串包含**（如 `industry:'Semi'` 匹配 Semiconductors / Semi Equipment）。" +
      "**返回 0 个候选时看 `hint` 字段**，里面会建议放宽哪个 criteria。" +
      "**用法**：用户提'分析 AI 半导体板块机会' → `run_screener({universe:'US', criteria:{industry:'Semi'}, topN:5})` 拿候选 → 对每个候选跑分析。",
    category: "research",
  },

  // 行情
  "market.ide_subscription.get": {
    description:
      "读取 IDE 本机自选订阅及已抵达 IDE 的行情缓存；不访问 Agent 记忆、不触发网络、不读取券商。" +
      "用于用户问“我的自选/订阅了什么”。返回每个标的的市场、缓存状态、来源和新鲜度；需要券商实时报价再显式调用 market.broker_quote.get。",
    category: "market",
  },
  "market.broker_quote.get": {
    description:
      "从已配置的券商行情桥（Futu / IB / SuperMind）一次性读取指定 symbols 的实时行情。" +
      "params: symbol|symbols, exchange?, provider?/bridge?, timeoutMs?。只接受券商推流，桥不可用/超时会明确失败，绝不降级到公共行情源。",
    category: "market",
  },
  "market.options.strategy_analyze": {
    description:
      "本机只读期权策略分析模块。支持 single、vertical、covered_call、collar、straddle、strangle、calendar、diagonal、butterfly、condor、iron_butterfly、iron_condor 与 custom 多腿。" +
      "params: symbol/underlying, strategy, exchange?, expiry?, farExpiry?（calendar/diagonal）, centerStrike?, widthSteps?, quantity?, singleRight?, singleSide?, direction?, legs?。" +
      "返回策略腿、净权利金、盯市损益、到期盈亏平衡、情景盈亏、Greeks 与风险边界；只读，不创建订单或持仓。L0 研究级期权链不可用于交易决策或订单准入。",
    category: "market",
  },
  "market.watchlist.get": {
    description:
      "[兼容] 聚合本机自选与券商持仓。新代码应拆开：market.ide_subscription.get 读取 IDE 自选；market.broker_quote.get 读取券商行情。",
    category: "market",
    lifecycle: "deprecated",
    replacedBy: "market.ide_subscription.get",
    deprecationReason: "混合了 IDE 自选和券商持仓，数据边界不清晰",
    resolveAlias: false,
  },
  "market.resolve_symbol": {
    description:
      "调用行情工具前统一识别 symbol 所属市场和 exchange，返回 CN/HK/US/CRYPTO 等市场、置信度和判断原因。" +
      "支持单个 symbol/ticker/code 或批量 symbols/tickers；单标返回扁平结果，多标返回 {results,count}。",
    category: "market",
  },
  "market.data_sources": {
    description:
      "查看行情源能力与实时治理状态：市场/周期覆盖、凭证、成功率、P95、最近错误、熔断、优先级和 fallback。可按 market/timeframe 过滤。注意：这是 source probe 状态，不代表 call_team_market_data 的 A2A 调度状态；团队超时不能据此改判为行情源不可用。",
    category: "market",
  },
  "market.readiness": {
    description:
      "查看启动行情 source readiness gate；只有真实样本探针通过才会报告 ready。它证明至少一个底层源可直拉，不证明专家团队调度一定在时限内完成。",
    category: "market",
  },
  "market.snapshot.get": {
    description:
      "D2/D3：生成或复用不可变市场快照，返回 snapshotId / dataRef / qualityVerdict / asOf / warnings。" +
      "研究、回测应引用 snapshotId；下单前须保证 qualityVerdict.tradable=true（仅 L3 + trading_allowed + 质量门通过）。" +
      "支持 symbols[] 或 symbol；可传 asOf/purpose/timeframe/limit；也可只传 snapshotId 回放。" +
      "质量不足时仍返回快照但带 warnings（研究 fail transparent）；订单入口会 fail closed。",
    category: "market",
  },
  "research.thesis.write": {
    description:
      "写入结构化 ResearchThesis（Prime D4）：返回幂等 thesisId 并自动开立 forecast book。" +
      "优先传 snapshotId（market.snapshot.get / evidence[].ref=mkt_snapshot_*）；缺省时会按 symbols 自动拉 snapshot，行情失败则用 unbound 占位并 warning。" +
      "必填：instrumentScope/symbols（也可从 narrative 推断如 600519.SH / AAPL）+ direction(long|short|neutral，中文看多/看空/震荡亦可，缺省从正文推断否则 neutral)。" +
      "confidence 用 0–1（也接受 low/medium/high 或 0–100 百分制）。" +
      "可选：horizon、claims[]、invalidation[]、knownUnknowns、modelAndPromptVersion。" +
      "研究结论应走本工具，而不是只写 Markdown；后续归因用 research.forecast_book.*。",
    category: "research",
  },
  "research.forecast_book.get": {
    description:
      "读取 forecast book 条目（thesis ↔ 风险审批 / 订单 / 成交 / 持有期结果）。" +
      "传 thesisId、entryId 或 bookId（fb_*，即 thesis.write 返回的 forecastBookEntryId）。",
    category: "research",
  },
  "research.forecast_book.link": {
    description:
      "向 forecast book 幂等追加链接：recommendationId、riskDecisionIds、orderIntentIds、fillIds、holdingPeriodResult。" +
      "不改动下单/风控状态机，仅做评测归因旁路。",
    category: "research",
  },
  "execution.account.snapshot": {
    description:
      "只读读取指定 provider/account 的能力矩阵、持仓，以及可用时的余额/保证金；不会触发订单操作。" +
      "params: provider, accountRef?。适合执行监控和风险盘点。",
    category: "trading",
  },
  "execution.order.get": {
    description:
      "只读读取单个 broker order 的当前状态及成交明细。params: provider, brokerOrderId, accountRef?；" +
      "超时后先查订单，禁止基于未知状态盲目重下。",
    category: "trading",
  },
  "order.list_open": {
    description:
      "只读列出券商当前未完成订单。params: provider, accountRef?；仅当 provider.capabilities.openOrders=true 时可用。",
    category: "trading",
  },
  "provider.capabilities": {
    description:
      "读取指定 Broker/Exchange Sidecar 的规范化能力矩阵（订单、open orders、改单、余额、保证金、事件流、对账）。" +
      "params: provider, accountRef?；调用高副作用工具前先检查。",
    category: "trading",
  },
  "execution.reconcile.positions": {
    description:
      "只读执行内部账本与券商持仓对账并生成 remediation proposal；不执行修复单。" +
      "params: projectId?, provider, accountRef?。",
    category: "risk",
  },
  "execution.kill_switch.status": {
    description:
      "只读检查 global/provider/account/project/strategy 多级交易熔断开关。" +
      "params 可选 provider/accountRef/projectId/strategyId；返回 clear 与 engaged scopes。",
    category: "risk",
  },
  "portfolio.construct": {
    description:
      "确定性组合构建（Prime D5）：必须绑定 thesisId（snapshot 可从 thesis 派生）。" +
      "基于 thesis 方向/标的，或显式 candidates[] / allocation[{symbol,weight,side?}] 调用分配引擎；" +
      "neutral thesis 必须传 candidates/allocation。返回 TargetPortfolio（含 portfolioId/rows/exposures）。" +
      "不经 LLM 裁决仓位；可选 capital/grossLimit/netLimit/perPositionMax。",
    category: "trading",
  },
  fetch_bars: {
    description: "拉取 OHLCV K 线（多数据源：Yahoo/东财/AkShare 等）",
    category: "market",
    lifecycle: "deprecated",
    replacedBy: "fetch_klines",
    deprecationReason: "与 fetch_klines 是同一接口的两个名字，统一使用 fetch_klines",
  },
  fetch_klines: {
    description:
      "市场感知的 OHLCV K 线：支持单个 symbol/ticker/code 或批量 symbols/tickers；兼容 timeframe/period/interval 与 limit/count/bars、startDate|from、endDate|to|asOf。" +
      "模型通常不知道“今天”：调用前须先确定 as-of（当前 UTC/交易所日），缺省 limit=250（约 1Y 日线）并以今天为 endDate；只传一端日期时系统会按 limit 补全另一端。" +
      "自动判断市场，并按源覆盖、周期、凭证、健康度、优先级和熔断状态依次降级。失败会明确返回所有尝试源，不得盲目重复。",
    category: "market",
  },
  fetch_ticks: {
    description:
      "拉取真实 L1 Tick 快照；无真实源时明确失败，绝不返回模拟报价。" +
      "支持单个 symbol/ticker/code 或批量 symbols/tickers；单标返回 Tick 数组，多标返回 {ticks,warnings?}。",
    category: "market",
  },
  fetch_quote: {
    description:
      "拉取标准化实时/准实时报价，包含来源、时间戳与新鲜度。" +
      "支持单个 symbol/ticker/code 或批量 symbols/tickers；单标返回扁平 Quote，多标返回 {quotes,warnings?}。",
    category: "market",
  },
  fetch_option_chain: {
    description:
      "查询港美上市期权链（Call/Put、行权价、到期、Bid/Ask、成交量、未平仓、隐含波动率）。" +
      "params: symbol 或 underlying，exchange?，expiry?，source? (auto|futu|alpaca|research)。auto 先尝试富途 OpenD、再 Alpaca 券商快照，失败时才返回明确标记的 Yahoo/yfinance 研究级降级；source=futu/alpaca 禁止降级。",
    category: "market",
  },
  fetch_order_book: {
    description: "拉取标准化买卖盘口；CN 当前支持东财五档，CRYPTO 支持 Binance 深度",
    category: "market",
  },
  fetch_trades: {
    description: "拉取逐笔成交/Time & Sales，并标准化主动买卖方向",
    category: "market",
  },
  fetch_chip_distribution: {
    description: "拉取 A 股筹码分布：获利比例、平均成本、70%/90% 成本区间及集中度",
    category: "market",
  },
  fetch_price_data: {
    description: "K 线 + 最新技术指标快照（SMA/RSI/MACD/布林）",
    category: "market",
  },
  fetch_financial_data: {
    description: "[Retired] 价格统计与基本面混合入口；改用 fetch_klines + fetch_fundamentals",
    category: "market",
    lifecycle: "deprecated",
    replacedBy: "fetch_fundamentals",
    deprecationReason: "混合了价格与财报语义，导致模型把占位结果当作真实基本面",
  },
  fetch_fundamentals: {
    description:
      "标准化年度/季度基本面数据；通过可用 provider 返回真实 periods，源不可用时明确失败",
    category: "market",
  },
  write_snapshot: {
    description: "写入行情/研究数据快照供下游复用",
    category: "market",
  },

  // 研究
  compute_factors: {
    description: "从 K 线计算动量等因子及 IC 代理",
    category: "research",
    lifecycle: "deprecated",
    replacedBy: "factor.compute",
    deprecationReason: "旧因子链路，已被 M2 三段式因子套件取代",
  },
  run_experiment: {
    description: "记录假设并跑单因子实验，写入 factor_definition",
    category: "research",
    lifecycle: "deprecated",
    replacedBy: "factor.autoEvaluate",
    deprecationReason: "旧实验链路，已被 M6 factor.autoEvaluate 取代",
  },
  version_strategy: {
    /**
     * 2026-06-08 P0-1.b 修复：F-P0-11 当年取消 deprecated 是因为旧 alias target
     * (strategy.compose) 与 version_strategy 不等价（compose 要 strategy_version_id 才能调）。
     * 现在我们新增了等价的 builtin tool `strategy.create_version`，可以正确 alias。
     *
     *   - `version_strategy`（旧 qubit-research connector op）= 创建 strategy + strategy_version
     *   - `strategy.create_version`（新 builtin tool）= 同样的语义，但不依赖 MCP connector
     *
     * 标 deprecated 让 alias resolver 把 LLM 的 `version_strategy` 调用静默 rewrite 成
     * `strategy.create_version`，调用入参兼容（strategy.create_version 接受 name + style，
     * connector op 用 strategyName + params，由 act 节点的入参 rewrite 兜底）。
     */
    description:
      "[Deprecated] 在 qubit-research connector 上创建 strategy + strategy_version 版本记录。**已被 builtin tool `strategy.create_version` 取代**（不依赖 MCP，更稳定）。",
    category: "research",
    lifecycle: "deprecated",
    replacedBy: "strategy.create_version",
    deprecationReason:
      "builtin strategy.create_version 等价且不依赖 MCP connector；2026-06-08 Round 6 复盘确认替换。",
  },
  compute_indicators: {
    description: "计算 SMA/RSI/MACD/布林带等指标序列",
    category: "research",
  },
  detect_patterns: {
    description: "识别市场状态（趋势/震荡）与金叉/死叉",
    category: "research",
  },
  compute_valuation: {
    description: "估值代理：现价相对 252 日均价（非财报 PE）",
    category: "research",
  },

  // 回测
  run_backtest: {
    description: "[Retired] 旧 SMA 回测入口",
    category: "backtest",
    lifecycle: "deprecated",
    replacedBy: "backtest.run",
    deprecationReason: "与规范 backtest.run 重复",
  },
  get_backtest_status: {
    description: "[Retired] 旧回测状态入口",
    category: "backtest",
    lifecycle: "deprecated",
    replacedBy: "backtest.run",
    deprecationReason: "规范 job 由 backtest.run 返回并查询",
  },

  // 交易
  submit_order: {
    description: "提交已风控批准的实盘/券商订单意图",
    category: "trading",
  },
  cancel_order: { description: "撤销券商订单", category: "trading" },
  get_fills: { description: "查询成交回报", category: "trading" },
  submit_paper_order: {
    description: "纸交易下单（模拟成交与滑点）",
    category: "trading",
  },
  get_paper_position: {
    description: "查询纸交易虚拟持仓",
    category: "trading",
  },

  // 风控
  evaluate_risk: {
    description: "交易前风险评估（置信度/辩论共识/否决规则）",
    category: "risk",
  },
  sign_intent: { description: "对订单意图做批准或拒绝签核", category: "risk" },
  load_rules: { description: "加载当前风控规则配置摘要", category: "risk" },
  check_concentration: {
    description: "检查单标的/行业集中度是否超限",
    category: "risk",
  },
  assess_liquidity: {
    description: "评估订单相对成交量的冲击比例",
    category: "risk",
  },

  // 舆情
  fetch_news: {
    description:
      "抓取带发布时间、来源与可选正文的新闻。内置 Yahoo Finance / Google News RSS，并可对头条链接做 web 抓取补全文；也可配置自定义 newsApiBaseUrl。只接受新鲜、标的相关、非 synthetic 证据。",
    category: "sentiment",
  },
  fetch_news_sentiment: {
    description:
      "对通过时效性/相关性证据门的新闻聚合情绪；空数据、过期或 synthetic 结果必须降级，不得当作中性新闻。优先使用 fetch_news 拉到的真实条目。",
    category: "sentiment",
  },
  extract_event: {
    description: "从文本抽取结构化事件（简化 stub）",
    category: "sentiment",
    lifecycle: "stub",
    deprecationReason: "返回与输入文本无关的硬编码事件，未对接 NER/事件抽取服务",
  },
  score_sentiment: {
    description: "对单条文本做情绪打分",
    category: "sentiment",
    lifecycle: "stub",
    deprecationReason: "返回固定 0/正/负三档，未对接真实情绪模型",
  },
  analyze_social_media: {
    description: "基于新闻头条的舆情热度代理",
    category: "sentiment",
    lifecycle: "stub",
    deprecationReason: "实际仅基于新闻头条做关键词计数，非真实社媒数据",
  },
  // 宏观
  fetch_macro_data: {
    description: "基准指数 K 线推导宏观 regime 与风险偏好",
    category: "macro",
    lifecycle: "deprecated",
    replacedBy: "compute_macro_indicators",
    deprecationReason: "1 行别名，统一走 compute_macro_indicators",
  },
  compute_macro_indicators: {
    description: "基准指数推导宏观 regime（risk_on/off 标签）",
    category: "macro",
  },

  // 记忆
  write_memory: {
    description: "写入项目/Agent 中期或长期记忆",
    category: "memory",
  },
  search_memory: { description: "按关键词检索记忆条目", category: "memory" },
  cleanup_ttl: {
    description: "预览过期记忆清理（TTL）",
    category: "memory",
    lifecycle: "stub",
    deprecationReason: "仅返回预览，未真正执行清理；后台 ttl-sweeper 已自动处理",
  },
  "memory.summarize_workflow": {
    description: "主动归纳当前工作流为 midterm（通常 workflow 结束自动触发）",
    category: "memory",
  },
  "memory.consolidate_longterm": {
    description: "把多条 midterm 提炼为 longterm（factor_archive / regime / playbook 等）",
    category: "memory",
  },
  "memory.refresh_workspace": {
    description: "把当前 Agent 的长期记忆同步到 workspace/memory.md（让用户可见）",
    category: "memory",
  },

  // M11 自进化：skill 程序性记忆（可被检索、复用、自我迭代；区别于 memory 的事实/约束）
  "skill.create": {
    description:
      "完成 5+ 步复杂任务/修复 tricky 错误/发现非平凡流程后调；落 agent_skill。description 用于 LLM 检索（≤500 字），bodyMd 为完整流程（≤16KB）。下次匹配 goal 时会被自动召回到 user prompt。",
    category: "memory",
  },
  "skill.view": {
    description: "按 id 或 name 查看完整 skill（含 bodyMd / 使用计数）",
    category: "memory",
  },
  "skill.list": {
    description: "列出当前项目的全部 skill（默认排除 archived；可传 state 过滤）",
    category: "memory",
  },
  "skill.search": {
    description: "按关键词检索 skill（pinned > 当前 def > 近期使用 > 命中次数 加权）",
    category: "memory",
  },
  "skill.patch": {
    description:
      "使用中发现 skill 过时/不全/错误时立即修补；自动 bumpVersion（v1→v1.1）。可改 description/bodyMd/category/pinned/state。",
    category: "memory",
  },
  "skill.archive": {
    description: "软删（state=archived，可通过 skill.patch state=active 恢复）；从不物理删除",
    category: "memory",
  },
  "skill.use_record": {
    description:
      "调用某 skill 完成任务后记录用量：outcome(success|fail|partial)，score，notes。Curator 与 Evolution 都看这条信号。",
    category: "memory",
  },
  "skill.import_market": {
    description: "把已 install 的 open_skill_market 条目镜像到 agent_skill，统一走 skill 检索",
    category: "memory",
  },

  // 审计
  write_audit_log: {
    description: "关键操作写入 audit_log 留痕",
    category: "audit",
  },
  generate_report: {
    description: "汇总分析师信号生成 Markdown 研报",
    category: "audit",
  },

  // Self-Evolving Agent P7：agent 自报缺工具，喂给 ToolGapWatcher（→ P8 AutoInstaller 候选）
  "tool.report_gap": {
    description:
      "上报当前 agent 想用但找不到 / 失败 / 不知怎么用的工具：参数 toolName 或 reason 至少一个；可选 serverName（MCP）/ toolKind。Watcher 会按 gap_signature 去重累计 occurrence_count。",
    category: "audit",
  },

  // M2：因子/规则/策略 三段式工具（详见 FACTOR_RULE_STRATEGY_DESIGN.md §6.1-6.3）
  "factor.register": {
    description:
      "注册因子并返回 `factor_id`（落 factor_definition）。必填：`name`、`category`、`expr`（兼容 `expression`/`factor_expression`）、`lang:'qlib_expr'|'python'`；可选 `universe`/`horizon`/`dry_run:false`。参数平铺在顶层，不要包在 `arguments` 里。优先技术/量价示例：`EMA(close,12)-EMA(close,26)`、`(close-Min(low,9))/(Max(high,9)-Min(low,9)+1e-8)`、`volume/Mean(volume,20)`。后续 factor.compute 必须用返回的 factor_id。",
    category: "research",
  },
  "factor.compute": {
    /**
     * 2026-06-05 监控复盘 #3：旧 description "计算因子值（走 FactorComputeProvider）"
     * 不告诉 LLM 必须传 `factor_id` (UUID)，导致 LLM 凭训练记忆传 `{symbol, ticker}`
     * 直接抛 "factor_id is required" 浪费工具调用轮次。
     * 现在显式标注 schema + 数据依赖（先 register 拿 id），让 LLM 一看就知道前置步骤。
     */
    description:
      "计算因子值并写入 factor_value。**必填 `factor_id` (UUID)**（来自 factor.register 或 factor.list 返回），可选 `symbols[]` / `start_date` / `end_date`。若 factor.register 已设置 `universe`，通常不要传指数代码（如 000300.SH）当 symbols；省略 symbols 时会按 universe 展开最小横截面样本。**不要传 `symbol`/`ticker`/`factor_expression`** —— 那些是 factor.autoEvaluate / factor.register 的参数。",
    category: "research",
  },
  "factor.evaluate": {
    description: "评估因子（IC/RankIC/IR/衰减/换手），结果写 factor_evaluation 留痕",
    category: "research",
    lifecycle: "deprecated",
    replacedBy: "factor.autoEvaluate",
    deprecationReason: "factor.autoEvaluate 已包含 evaluate 能力且自动接入市场数据",
  },
  "rule.register": {
    description: "注册规则（落 rule_definition；走 RuleEngineProvider.parse 校验 DSL）",
    category: "research",
  },
  "rule.evaluate": {
    description: "执行规则（走 RuleEngineProvider.evaluate；写 rule_evaluation_log 留痕）",
    category: "research",
  },
  "strategy.create_version": {
    /**
     * P0-1.b（2026-06-08 Round 6 复盘）：strategy_author 一直没工具落 strategy / strategy_version，
     * 现在补这个让"最后一公里"能写库。
     */
    description:
      "创建策略版本（落 strategy + strategy_version，按 project+name 幂等）。**仅创建，不支持 action=get/list**。" +
      "**必填顶层 `name`**（也接受 strategyName / strategy.name）；可选 style/description/universe/version_tag。" +
      "字段请平铺；若误包在 `arguments` 内也会自动展开。" +
      "顺序：① create_version → ② strategy.compose → ③ backtest.run / order.create_intent。",
    category: "research",
  },
  "strategy.compose": {
    /**
     * 2026-06-05 监控复盘 #3：旧 description 不告诉 LLM 必须先有 strategy_version_id。
     * 实测最近 1d 20 次调用 20 次失败，全部"strategy_version_id is required"。
     * 2026-06-08 P0-1.b：把"先 strategy.create_version 拿 id"补进调用顺序。
     */
    description:
      "把已有的 factor_ids / rule_ids 组合到一个**已存在的** strategy_version 上（落 strategy_composition）。**必填 `strategy_version_id`** (UUID, 来自 strategy.create_version 返回)。**调用顺序**：① strategy.create_version 拿 id → ② strategy.compose 组合 factor/rule → ③ backtest.run。一上来直接调 compose 会失败。",
    category: "research",
  },
  "strategy.compile": {
    description:
      "编译 Strategy API V2 Python 源码为不可变 StrategyManifest（不跑行情）。**必填 `code`**（也接受 strategyCode/source）。" +
      "initialize 只能声明 universe/subscribe/warmup/benchmark；禁止 get_history/order_*。" +
      "成功后可用 strategy.contract_backtest 同码回测，或 strategy.paper_deploy 开纸交易 Session。",
    category: "research",
  },
  "strategy.verify": {
    description: "strategy.compile 的别名：验证 Strategy API V2 源码能否编译为 Manifest。",
    category: "research",
  },
  "strategy.contract_backtest": {
    description:
      "同码契约回测：compile + SimBroker（next-open 成交）。**必填 `code`**；可选 symbol/limit/timeframe/params/initial_capital。" +
      "未传 bars 时按 Manifest 主标的拉 K 线。输出权益曲线摘要 + intents 审计。" +
      "与旧 backtest.run（因子组合）不同；写码验证优先用本工具。",
    category: "research",
  },
  "strategy.paper_deploy": {
    description:
      "同 Manifest 纸交易 Session：编译源码 → 固定纸本金注册 PaperSession（默认 100000）。**必填 `code`**。" +
      "会尽量 strategy.create_version 并把 Manifest 写入版本元数据。下一步 strategy.paper_run。",
    category: "trading",
  },
  "strategy.paper_run": {
    description:
      "推进纸交易 Session：同码回放 → 镜像成交为 dispatch_mode=paper 的 order_intent。" +
      "**必填 `session_id`**（或直接传 code 以先 deploy）。可选 dry_run/limit/max_orders。" +
      "权益口径=会话固定纸本金（非账户权益）。需在 research workflow 内且绑定 strategy_version 才会写库。",
    category: "trading",
  },
  "strategy.sim_deploy": {
    description:
      "部署持久化的策略到**券商模拟盘**：用 `script_id`（来自 strategy.compile）或完整 `code`，创建并默认启动 `execution_mode=sim` 的 runtime。" +
      "Strategy API V2 合约会在每根新收盘 K 线计算目标仓位，以 `paper_capital`（默认 100000）换算整股差额；普通 indicator/script 则传 `order_qty`。" +
      "可选 `broker_account_id`，否则解析启用的 Futu sandbox/mock 账户。账户必须是 sandbox/mock，绝不走 live。",
    category: "trading",
  },
  "order.create_intent": {
    /**
     * P0-1.c（2026-06-08 Round 6 复盘）：trader 没工具下单 → live_trading 团队 0 产物。
     * 包 createOrderIntentWithExecution，默认 paper mode 安全；走完 pre-trade risk 检查后落 order_intent。
     */
    description:
      "下达一个交易意向（落 order_intent + 证据绑定 + 数据质量门 + pre-trade risk + execution_task）。**必填**：`strategy_version_id` + `symbol` + `side` + `qty`。" +
      "可选：`thesis_id`/`thesisId`（Prime D5）、`snapshot_id`/`snapshotId`、`order_type`、`price`、`time_in_force`、`market`、`broker_account_id`、`dispatch_mode`。" +
      "`dispatch_mode`：`paper`=本地假成交（默认）；`sim`=券商模拟盘（如 Futu TrdEnv.SIMULATE，可自动解析 sandbox 账户）；`live`=真钱。" +
      "**Live 必须传 thesisId**（snapshot 可从 thesis 派生，且 qualityVerdict.tradable=true）。sim 不强制 thesis，便于规则/因子快环。" +
      "研究级 paper 可暂不传（会记 warning）。成功后旁路写入 forecast book。",
    category: "trading",
  },
  "recommendation.record": {
    description:
      "记录结构化 DecisionSignal，并自动进入后验验证。**必填**：symbol/ticker（可嵌在 arguments 内）+ side(long/short/neutral 或 buy/sell/hold；缺省时可从 action 推断)。" +
      "强烈建议提供 entry_low/entry_high、stop_loss、take_profit、position_size_pct、invalidation_conditions[]、watch_conditions[]；" +
      "可选 confidence(0–1)、score、horizon_days、rationale、evidence[]、market、benchmark_symbol、expires_at、data_asof。" +
      "必须在真实研究 workflow 内调用（会绑定 workflow_run + project）。",
    category: "research",
  },

  // M6：Agent 直通量化工坊
  "factor.list": {
    description: "列出项目下因子（支持 category / status 过滤），用于 Agent 自助查询可用因子池",
    category: "research",
  },
  "factor.autoEvaluate": {
    /**
     * 2026-06-05 监控复盘 #3：旧 description 没强调 schema → LLM 经常缺 start_date/end_date/factor_id。
     * 2026-08：缺日期时默认近 1 年窗口；仍建议显式传日期。
     */
    description:
      "一步式评估因子（IC/RankIC/IR/衰减/分组收益）。**必填 `factor_id`**（或一步式 `factor_expression`+`name`）。" +
      "`start_date`/`end_date`（YYYY-MM-DD）强烈建议显式传；缺省则用近 365 天。" +
      "IC 是横截面指标：symbols 建议 ≥3（更好 ≥10）；单标的请换 factor.compute。" +
      "已有 universe 时勿把指数代码当唯一 symbols。",
    category: "research",
  },
  "factor.evaluate.batch": {
    description:
      "批量自动评估多个因子（≤30 个）：串行调 autoEvaluate，返回每个因子的 IC/RankIC/IR + 聚合 summary（mean RankIC、显著因子数、最佳/最差因子）。一次拿一组候选因子的 RankIC 排名时优先用这个，比循环调 autoEvaluate 节省工具调用轮数。",
    category: "research",
  },
  "factor.promote_backtest": {
    description:
      "P0 一键闭环：把已有 factor_ids 自动提升为 strategy_version + strategy_composition，并立即运行事件驱动回测（落 backtest_run + strategy_eval_run）。**必填**：factor_ids[] + start_date + end_date。可选 symbols[]；不传时按因子 universe 使用默认样本。优先在 factor.autoEvaluate 成功后调用，用于让量化工坊直接观察「因子→策略→回测」完整链路。",
    category: "research",
  },
  "discovery.run": {
    description:
      "提交并运行因子挖掘任务（factor_alpha101 模板 / factor_gp 符号回归 / 其他 kind），返回候选 + IC 评估",
    category: "research",
  },
  "factor.mine.llm": {
    description:
      "批量挖因子并闸门 promote：必填 `expressions:string[]`（≥min_count 默认5 的 qlib_expr）、`symbols[]`、`start_date`、`end_date`；可选 `top_k`/`ic_threshold`/`auto_promote`/`name_prefix`/`category`。不要只传 task/targets。表达式应覆盖动量+MACD/KDJ+量价，例如 EMA(close,12)-EMA(close,26)、(close-Min(low,9))/(Max(high,9)-Min(low,9)+1e-8)、volume/Mean(volume,20)。返回 job_id + candidates + promoted。",
    category: "research",
  },
  "discovery.promote": {
    description:
      "把挖掘出的候选表达式 promote 为项目下正式 factor_definition（保留 lineage 到 discovery_job）",
    category: "research",
  },
  "backtest.run": {
    /**
     * 2026-06-05 监控复盘 #3：旧 description 没标"必填 strategy_version_id"。
     * 2026-08：缺 dates 默认近 1 年；缺 composition_id 时自动取该 version 最新 compose。
     */
    description:
      "事件驱动回测并落 backtest_run。**必填**：`strategy_version_id` + `symbols[]`（或单标 symbol/ticker）。" +
      "`start_date`/`end_date` 建议显式；缺省近 365 天。" +
      "`composition_id` 与 `signals` 二选一；刚 compose 过可不传 composition_id（自动取该 version 最新组合）。" +
      "顺序：create_version → compose → backtest.run。",
    category: "research",
  },

  // M7：沙箱代码执行（Agent 在 chat 里跑 pandas / 算 IC 矩阵 / 算相关性等）
  "code.run_python": {
    description:
      "默认在受限 Python 中执行（numpy/pandas/scipy 等）；可注入 vars、指定 return_var。仅当 Agent 的 sandbox policy 显式配置 pythonSandbox.mode='container' 时，可传 dangerous=true 在网络关闭、只读根文件系统、无 Linux capabilities 且受 CPU/内存/PID 限制的容器中执行任意 Python/依赖。容器依赖从 policy 声明的 wheelhouse 离线安装，绝不在宿主机安装。",
    category: "research",
  },

  // Exec 能力源：本地 CLI 工具 + 外部 agentic CLI
  // 详见 src/runtime/exec/types.ts 设计文档（2026 "CLI vs MCP" 争论后的 hybrid 方案）
  "shell.exec": {
    description:
      "执行 EXEC_PROVIDERS 白名单中的本地 CLI（默认 git/jq/rg/duckdb）。参数：binary, args[], cwd(必须在 workflow/project/data 目录内), timeoutMs?, stdinText?。args 走数组形式不经 shell。返回 {ok, exitCode, stdout, stderr, truncated, elapsedMs, error?}。",
    category: "exec",
    lifecycle: "experimental",
  },
  "cli_agent.run": {
    description:
      "把外部 agentic CLI（默认 claude-code/aider）作为子智能体调用，把长 horizon 编码任务整包外包。参数：agentId, task(自然语言), cwd, files?, timeoutMs?。LLM 不自由组装 args，由 provider.argTemplate 渲染。默认 10min 超时，输出截断 256KB。",
    category: "exec",
    lifecycle: "experimental",
  },
};

function metaFor(
  name: string,
  kind: ToolCatalogEntry["kind"],
  connector?: string
): ToolCatalogEntry {
  if (isTopologyTeamTool(name)) {
    const role = parseRoleFromTopologyTeamTool(name);
    return {
      name,
      kind: "builtin",
      description: role ? topologyTeamToolDescription(role) : "编组拓扑派单",
      category: "orchestration",
    };
  }
  const m = TOOL_META[name];
  const description =
    m?.description ??
    (kind === "connector" && connector ? `经 ${connector} 连接器执行` : "内置工具");
  const entry: ToolCatalogEntry = {
    name,
    kind,
    description,
    category: m?.category ?? (kind === "connector" ? "market" : "orchestration"),
  };
  if (connector !== undefined) entry.connector = connector;
  if (m?.lifecycle !== undefined) entry.lifecycle = m.lifecycle;
  if (m?.replacedBy !== undefined) entry.replacedBy = m.replacedBy;
  if (m?.deprecationReason !== undefined) entry.deprecationReason = m.deprecationReason;
  return entry;
}

/** Full catalog for config UI / agent authoring. */
export function buildToolCatalog(): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const [name, connector] of Object.entries(TOOL_CONNECTOR_ROUTES)) {
    if (isRetiredGlobalToolName(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push(metaFor(name, "connector", connector));
  }
  for (const name of listRegisteredBuiltinTools()) {
    if (isRetiredGlobalToolName(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push(metaFor(name, "builtin"));
  }
  /** deprecated 别名若已从 connector 路由移除，仍保留在 catalog 供 UI / 契约测试 */
  for (const [name, meta] of Object.entries(TOOL_META)) {
    if (isRetiredGlobalToolName(name)) continue;
    if (seen.has(name) || meta.lifecycle !== "deprecated") continue;
    seen.add(name);
    const connector = TOOL_CONNECTOR_ROUTES[name];
    entries.push(metaFor(name, connector ? "connector" : "builtin", connector));
  }
  return entries.sort((a, b) => {
    const ca = a.category ?? "orchestration";
    const cb = b.category ?? "orchestration";
    if (ca !== cb) return ca.localeCompare(cb);
    return a.name.localeCompare(b.name);
  });
}

export function getToolCatalogMap(): Map<string, ToolCatalogEntry> {
  return new Map(buildToolCatalog().map((e) => [e.name, e]));
}

/**
 * 把 deprecated 别名工具解析到 `replacedBy` 指向的工具。
 * 仅当 TOOL_META 中标了 `lifecycle: "deprecated"` 且 `replacedBy` 也在 TOOL_META 中存在时生效，
 * 避免链式跳转或指向不存在的工具。
 *
 * 用法：在 act 节点 dispatch 前调用，让旧 prompt 调用 deprecated 工具时透明走到 replacement。
 */
export function resolveToolAlias(name: string): {
  resolved: string;
  aliased: boolean;
  originalName: string;
  replacedBy?: string;
} {
  const meta = TOOL_META[name];
  if (meta?.lifecycle === "deprecated" && meta.replacedBy && meta.resolveAlias !== false) {
    const target = TOOL_META[meta.replacedBy];
    // 防御：target 必须存在且本身不是 deprecated（避免链式跳转）
    if (target && target.lifecycle !== "deprecated") {
      return {
        resolved: meta.replacedBy,
        aliased: true,
        originalName: name,
        replacedBy: meta.replacedBy,
      };
    }
  }
  return { resolved: name, aliased: false, originalName: name };
}
