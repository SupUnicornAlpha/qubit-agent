import {
  isTopologyTeamTool,
  parseRoleFromTopologyTeamTool,
  topologyTeamToolDescription,
} from "../orchestration/topology-dispatch";
import { listRegisteredBuiltinTools } from "./builtin-tools";
import { TOOL_CONNECTOR_ROUTES } from "./tool-routes";
import type { ToolCatalogEntry, ToolCatalogCategory } from "./types";

/** 工具分类（配置中心 hover / 筛选） */
export const TOOL_CATALOG_CATEGORIES: Record<
  ToolCatalogCategory,
  { label: string; hint: string }
> = {
  orchestration: { label: "编排协作", hint: "任务拆解、派单、团队分析、信号融合" },
  market: { label: "行情数据", hint: "K 线、Tick、快照、财务数据代理" },
  research: { label: "量化研究", hint: "因子、指标、形态、估值、实验" },
  backtest: { label: "回测验证", hint: "历史回测与任务状态查询" },
  trading: { label: "交易执行", hint: "下单、撤单、成交、纸交易" },
  risk: { label: "风控合规", hint: "风险评估、签核、集中度与流动性" },
  sentiment: { label: "舆情事件", hint: "新闻、情绪、事件抽取" },
  macro: { label: "宏观策略", hint: "宏观指标与政策框架" },
  memory: { label: "记忆知识", hint: "跨会话记忆读写" },
  audit: { label: "审计报告", hint: "留痕与报告生成" },
};

const TOOL_META: Record<string, { description: string; category: ToolCatalogCategory }> = {
  // 编排
  task_decompose: { description: "将用户目标拆解为：拉数据 → 团队分析 → 回测 → 风控", category: "orchestration" },
  assign_task: { description: "向指定角色 Agent 派发工作流任务", category: "orchestration" },
  run_analyst_team: { description: "并行运行分析师编组，MSA 融合 + 可选辩论/风控", category: "orchestration" },
  fuse_signals: { description: "合并多分析师 buy/sell/hold 信号为统一结论", category: "orchestration" },
  check_risk: { description: "编排链路中的风控检查（调用 qubit-risk）", category: "orchestration" },
  edit_agent_pack: { description: "编辑本 Agent 的 soul/user/memory/prompt 文件", category: "orchestration" },
  call_mcp: {
    description: "调用 MCP 白名单中的外部工具（params: serverName, mcpTool, arguments）",
    category: "orchestration",
  },
  run_screener: { description: "按条件筛选股票候选（当前为演示股票池）", category: "research" },

  // 行情
  fetch_bars: { description: "拉取 OHLCV K 线（多数据源：Yahoo/东财/AkShare 等）", category: "market" },
  fetch_klines: { description: "同 fetch_bars，面向图表/Agent 的 K 线接口", category: "market" },
  fetch_ticks: { description: "拉取 Tick/盘口快照（简化实现）", category: "market" },
  fetch_price_data: { description: "K 线 + 最新技术指标快照（SMA/RSI/MACD/布林）", category: "market" },
  fetch_financial_data: { description: "价格统计 + 基本面占位；完整财报需外接数据源", category: "market" },
  fetch_fundamentals: { description: "基本面数据结构（无财报源时为空 periods）", category: "market" },
  write_snapshot: { description: "写入行情/研究数据快照供下游复用", category: "market" },

  // 研究
  compute_factors: { description: "从 K 线计算动量等因子及 IC 代理", category: "research" },
  run_experiment: { description: "记录假设并跑单因子实验，写入 factor_definition", category: "research" },
  version_strategy: { description: "创建 strategy / strategy_version 版本记录", category: "research" },
  compute_indicators: { description: "计算 SMA/RSI/MACD/布林带等指标序列", category: "research" },
  detect_patterns: { description: "识别市场状态（趋势/震荡）与金叉/死叉", category: "research" },
  compute_valuation: { description: "估值代理：现价相对 252 日均价（非财报 PE）", category: "research" },
  analyze_industry: { description: "输出行业分析框架（产业链/竞争/政策）", category: "research" },

  // 回测
  run_backtest: { description: "SMA 金叉死叉多空回测，写入 backtest_job", category: "backtest" },
  get_backtest_status: { description: "查询回测任务进度与结果", category: "backtest" },

  // 交易
  submit_order: { description: "提交已风控批准的实盘/券商订单意图", category: "trading" },
  cancel_order: { description: "撤销券商订单", category: "trading" },
  get_fills: { description: "查询成交回报", category: "trading" },
  submit_paper_order: { description: "纸交易下单（模拟成交与滑点）", category: "trading" },
  get_paper_position: { description: "查询纸交易虚拟持仓", category: "trading" },

  // 风控
  evaluate_risk: { description: "交易前风险评估（置信度/辩论共识/否决规则）", category: "risk" },
  sign_intent: { description: "对订单意图做批准或拒绝签核", category: "risk" },
  load_rules: { description: "加载当前风控规则配置摘要", category: "risk" },
  check_concentration: { description: "检查单标的/行业集中度是否超限", category: "risk" },
  assess_liquidity: { description: "评估订单相对成交量的冲击比例", category: "risk" },

  // 舆情
  fetch_news: { description: "抓取新闻列表（HTTP 源或 stub）", category: "sentiment" },
  fetch_news_sentiment: { description: "新闻列表 + 聚合情绪得分", category: "sentiment" },
  extract_event: { description: "从文本抽取结构化事件（简化 stub）", category: "sentiment" },
  score_sentiment: { description: "对单条文本做情绪打分", category: "sentiment" },
  analyze_social_media: { description: "基于新闻头条的舆情热度代理", category: "sentiment" },
  get_analyst_ratings: { description: "卖方评级（需外接数据源，当前为空）", category: "sentiment" },

  // 宏观
  fetch_macro_data: { description: "基准指数 K 线推导宏观 regime 与风险偏好", category: "macro" },
  analyze_policy: { description: "货币政策/财政政策分析框架", category: "macro" },
  compute_macro_indicators: { description: "同 fetch_macro_data，输出 risk_on/off 标签", category: "macro" },

  // 记忆
  write_memory: { description: "写入项目/Agent 中期或长期记忆", category: "memory" },
  search_memory: { description: "按关键词检索记忆条目", category: "memory" },
  cleanup_ttl: { description: "预览过期记忆清理（TTL）", category: "memory" },

  // 审计
  write_audit_log: { description: "关键操作写入 audit_log 留痕", category: "audit" },
  generate_report: { description: "汇总分析师信号生成 Markdown 研报", category: "audit" },

  // M2：因子/规则/策略 三段式工具（详见 FACTOR_RULE_STRATEGY_DESIGN.md §6.1-6.3）
  "factor.register": {
    description: "注册因子（落 factor_definition；走 Provider.validateExpr 做语法校验）",
    category: "research",
  },
  "factor.compute": {
    description: "计算因子值（走 FactorComputeProvider；P0 返回 in-memory rows）",
    category: "research",
  },
  "factor.evaluate": {
    description: "评估因子（IC/RankIC/IR/衰减/换手），结果写 factor_evaluation 留痕",
    category: "research",
  },
  "rule.register": {
    description: "注册规则（落 rule_definition；走 RuleEngineProvider.parse 校验 DSL）",
    category: "research",
  },
  "rule.evaluate": {
    description: "执行规则（走 RuleEngineProvider.evaluate；写 rule_evaluation_log 留痕）",
    category: "research",
  },
  "strategy.compose": {
    description: "组合 factor + rule 为可执行策略组合（落 strategy_composition）",
    category: "research",
  },

  // M6：Agent 直通量化工坊
  "factor.list": {
    description: "列出项目下因子（支持 category / status 过滤），用于 Agent 自助查询可用因子池",
    category: "research",
  },
  "factor.autoEvaluate": {
    description:
      "自动评估因子：从 DuckDB 取因子值 + 市场连接器取价格 → 计算 IC/RankIC/IR/衰减/分组收益/换手率",
    category: "research",
  },
  "factor.evaluate.batch": {
    description:
      "批量自动评估多个因子（≤30 个）：串行调 autoEvaluate，返回每个因子的 IC/RankIC/IR + 聚合 summary（mean RankIC、显著因子数、最佳/最差因子）。一次拿一组候选因子的 RankIC 排名时优先用这个，比循环调 autoEvaluate 节省工具调用轮数。",
    category: "research",
  },
  "discovery.run": {
    description:
      "提交并运行因子挖掘任务（factor_alpha101 模板 / factor_gp 符号回归 / 其他 kind），返回候选 + IC 评估",
    category: "research",
  },
  "discovery.promote": {
    description:
      "把挖掘出的候选表达式 promote 为项目下正式 factor_definition（保留 lineage 到 discovery_job）",
    category: "research",
  },
  "backtest.run": {
    description:
      "运行事件驱动回测：传 composition_id 或手写 signals，返回 metrics + equity_curve + trades 并落 backtest_run",
    category: "research",
  },

  // M7：沙箱代码执行（Agent 在 chat 里跑 pandas / 算 IC 矩阵 / 算相关性等）
  "code.run_python": {
    description:
      "受限沙箱内执行 Python：白名单 builtins + 仅放行 numpy/pandas/scipy/math 等；可注入 vars (含 factor 值/价格序列等)，可指定 return_var 取回结构化结果（DataFrame→records）；30s 超时，禁 import os/sys/socket，禁 open / 网络 / 子进程。",
    category: "research",
  },
};

function metaFor(name: string, kind: ToolCatalogEntry["kind"], connector?: string): ToolCatalogEntry {
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
    (kind === "connector" && connector
      ? `经 ${connector} 连接器执行`
      : "内置工具");
  return {
    name,
    kind,
    connector,
    description,
    category: m?.category ?? (kind === "connector" ? "market" : "orchestration"),
  };
}

/** Full catalog for config UI / agent authoring. */
export function buildToolCatalog(): ToolCatalogEntry[] {
  const entries: ToolCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const [name, connector] of Object.entries(TOOL_CONNECTOR_ROUTES)) {
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push(metaFor(name, "connector", connector));
  }
  for (const name of listRegisteredBuiltinTools()) {
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push(metaFor(name, "builtin"));
  }
  if (!seen.has("call_mcp")) {
    entries.push(metaFor("call_mcp", "builtin"));
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
