import {
  isTopologyTeamTool,
  parseRoleFromTopologyTeamTool,
  topologyTeamToolDescription,
} from "../orchestration/topology-dispatch";
import { listRegisteredBuiltinTools } from "./builtin-tools";
import { TOOL_CONNECTOR_ROUTES } from "./tool-routes";
import type { ToolCatalogEntry, ToolCatalogCategory, ToolLifecycle } from "./types";

type ToolMetaEntry = {
  description: string;
  category: ToolCatalogCategory;
  lifecycle?: ToolLifecycle;
  replacedBy?: string;
  deprecationReason?: string;
};

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
  exec: { label: "命令执行", hint: "本地 CLI 工具 + 外部 agentic CLI 子代理" },
};

const TOOL_META: Record<string, ToolMetaEntry> = {
  // 编排
  assign_task: { description: "向指定角色 Agent 派发工作流任务", category: "orchestration" },
  run_analyst_team: { description: "并行运行分析师编组，MSA 融合 + 可选辩论/风控", category: "orchestration" },
  summarize_team_decision: {
    description:
      "对 run_analyst_team 结果做全局兜底总结（仅在 confidence<0.6 / 信号分歧 / 签到不全时调用；高置信场景不需调）。入参：fusion_summary, ticker, msa_signal, msa_confidence, attended_roles?, missing_roles?",
    category: "orchestration",
  },
  fuse_signals: { description: "合并多分析师 buy/sell/hold 信号为统一结论", category: "orchestration" },
  check_risk: {
    description: "编排链路中的风控检查（调用 qubit-risk）",
    category: "orchestration",
    lifecycle: "deprecated",
    replacedBy: "evaluate_risk",
    deprecationReason: "与 evaluate_risk 编排重复，统一走规范风控入口",
  },
  edit_agent_pack: { description: "编辑本 Agent 的 soul/user/memory/prompt 文件", category: "orchestration" },
  call_mcp: {
    description: "调用 MCP 白名单中的外部工具（params: serverName, mcpTool, arguments）",
    category: "orchestration",
  },
  run_screener: {
    description: "按条件筛选股票候选（当前为演示股票池）",
    category: "research",
    lifecycle: "stub",
    deprecationReason: "返回固定演示股票池，未对接实际筛选服务",
  },

  // 行情
  fetch_bars: {
    description: "拉取 OHLCV K 线（多数据源：Yahoo/东财/AkShare 等）",
    category: "market",
    lifecycle: "deprecated",
    replacedBy: "fetch_klines",
    deprecationReason: "与 fetch_klines 是同一接口的两个名字，统一使用 fetch_klines",
  },
  fetch_klines: { description: "拉取 OHLCV K 线（多数据源：Yahoo/东财/AkShare 等）", category: "market" },
  fetch_ticks: { description: "拉取 Tick/盘口快照（简化实现）", category: "market" },
  fetch_price_data: { description: "K 线 + 最新技术指标快照（SMA/RSI/MACD/布林）", category: "market" },
  fetch_financial_data: { description: "价格统计 + 基本面占位；完整财报需外接数据源", category: "market" },
  fetch_fundamentals: { description: "基本面数据结构（无财报源时为空 periods）", category: "market" },
  write_snapshot: { description: "写入行情/研究数据快照供下游复用", category: "market" },

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
     * F-P0-11（2026-06-05 eval batch 3 retry / case 1 修复）：
     *
     * 之前被标 deprecated → aliased to strategy.compose 是误判：
     *   - `version_strategy`（qubit-research connector op）= **从零创建** 一条
     *     `strategy` + `strategy_version` 行，由 LLM 直接调用是 strategy_authoring
     *     场景的入口
     *   - `strategy.compose`（builtin tool）= 把 factor_ids / rule_ids **组合到一个
     *     已存在的 strategy_version** 上（必填 `strategy_version_id`）
     * 二者是上下游关系，不是替代关系。错误标 deprecated 后 alias resolver 在 act 节点
     * 把 LLM 的 `version_strategy` 调用静默 rewrite 成 `strategy.compose`，参数 schema
     * 完全错位 → 永远抛 "strategy_version_id is required" → 策略 tab 永空。
     */
    description:
      "在 qubit-research connector 上创建 strategy + strategy_version 版本记录（strategy_authoring 入口）。**必填** `projectId` / `strategyName` / `versionTag` / `params` (策略参数对象)。**返回** `{strategyId, strategyVersionId}` —— 后续 strategy.compose / backtest.run 需要这个 strategyVersionId。",
    category: "research",
  },
  compute_indicators: { description: "计算 SMA/RSI/MACD/布林带等指标序列", category: "research" },
  detect_patterns: { description: "识别市场状态（趋势/震荡）与金叉/死叉", category: "research" },
  compute_valuation: { description: "估值代理：现价相对 252 日均价（非财报 PE）", category: "research" },

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
  compute_macro_indicators: { description: "基准指数推导宏观 regime（risk_on/off 标签）", category: "macro" },

  // 记忆
  write_memory: { description: "写入项目/Agent 中期或长期记忆", category: "memory" },
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
  "skill.view": { description: "按 id 或 name 查看完整 skill（含 bodyMd / 使用计数）", category: "memory" },
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
  write_audit_log: { description: "关键操作写入 audit_log 留痕", category: "audit" },
  generate_report: { description: "汇总分析师信号生成 Markdown 研报", category: "audit" },

  // Self-Evolving Agent P7：agent 自报缺工具，喂给 ToolGapWatcher（→ P8 AutoInstaller 候选）
  "tool.report_gap": {
    description:
      "上报当前 agent 想用但找不到 / 失败 / 不知怎么用的工具：参数 toolName 或 reason 至少一个；可选 serverName（MCP）/ toolKind。Watcher 会按 gap_signature 去重累计 occurrence_count。",
    category: "audit",
  },

  // M2：因子/规则/策略 三段式工具（详见 FACTOR_RULE_STRATEGY_DESIGN.md §6.1-6.3）
  "factor.register": {
    description: "注册因子（落 factor_definition；走 Provider.validateExpr 做语法校验）",
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
      "计算因子值并写入 factor_value。**必填 `factor_id` (UUID)**（来自 factor.register 或 factor.list 返回），可选 `symbols[]` / `start_date` / `end_date`。**不要传 `symbol`/`ticker`/`factor_expression`** —— 那些是 factor.autoEvaluate / factor.register 的参数。前置依赖：先调 factor.register 创建 factor 拿到 id。",
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
  "strategy.compose": {
    /**
     * 2026-06-05 监控复盘 #3：旧 description 不告诉 LLM 必须先有 strategy_version_id。
     * 实测最近 1d 20 次调用 20 次失败，全部"strategy_version_id is required"。
     * LLM 在 reasonText 里写了 `{tool: "version_strategy", params: ...}` 想先版本化，
     * 但是 ReAct 一轮只能跑一个 tool call，没拿到 version_id 就直接调 compose → 必挂。
     */
    description:
      "把已有的 factor_ids / rule_ids 组合到一个**已存在的** strategy_version 上（落 strategy_composition）。**必填 `strategy_version_id`** (UUID, 来自 version_strategy 返回)。**调用顺序**：① version_strategy 创建 strategy + strategy_version 拿 id → ② strategy.compose 组合 factor/rule → ③ backtest.run 跑回测。一上来直接调 compose 会失败。",
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
     * 实测最近 1d 9 次调用 4 次失败：缺日期 / 缺 factor_id / 没先 compute。
     */
    description:
      "一步式评估因子（自动从 DuckDB 取因子值 + 市场连接器取价格 → IC/RankIC/IR/衰减/分组收益/换手率）。**必填三件套**：`factor_id` (UUID, 来自 factor.register/factor.list) + `start_date` (YYYY-MM-DD) + `end_date`。两种入参模式互斥：(A) 已有因子 → 传 factor_id ；(B) 新因子一步式 → 传 `factor_expression` (DSL) + `name` + `project_id`，工具会自动 register 再 evaluate。**前置依赖**：因子值表必须有数据（先调 factor.compute 写入），否则报 `no_factor_values`。",
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
  "factor.mine.llm": {
    description:
      "LLM 一次性产 N 个 qlib_expr 因子表达式 + 内置评估闸门：传 expressions[] (>=min_count，默认 5) → 跑 IC → 取 top_k → 自动 promote |IC|≥ic_threshold(默认 0.02) 的为 draft 因子。返回 job_id + top_candidates + promoted。详见 AGENT_STABILITY_REVIEW.md §四-P0-4。",
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
     * 实测最近 1d 30 次调用 29 次失败：15 次缺 strategy_version_id / 9 次缺 composition_id 或 signals / 1 次 composition_not_found。
     * 改：把完整 schema + 调用顺序写在最前面，让 LLM 一眼看到。
     */
    description:
      "运行事件驱动回测，返回 metrics + equity_curve + trades 并落 backtest_run。**必填**：`strategy_version_id` (UUID) + `symbols[]` + `start_date` + `end_date`，且 `composition_id` 与 `signals` 必须二选一传一个。**完整调用顺序**：① version_strategy 拿 strategy_version_id → ② strategy.compose 拿 composition_id → ③ backtest.run。或者跳过 compose 自己手写 `signals: {[symbol]: [{date, weight}]}` 也行。一上来直接调会失败。",
    category: "research",
  },

  // M7：沙箱代码执行（Agent 在 chat 里跑 pandas / 算 IC 矩阵 / 算相关性等）
  "code.run_python": {
    description:
      "受限沙箱内执行 Python：白名单 builtins + 仅放行 numpy/pandas/scipy/math 等；可注入 vars (含 factor 值/价格序列等)，可指定 return_var 取回结构化结果（DataFrame→records）；30s 超时，禁 import os/sys/socket，禁 open / 网络 / 子进程。",
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
  if (meta?.lifecycle === "deprecated" && meta.replacedBy) {
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
