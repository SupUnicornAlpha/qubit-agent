/**
 * 内置 Agent 角色字典（曾经的 `agent_role_catalog` 表）。
 *
 * 历史：该字典最初由 migration 0004 `INSERT OR IGNORE INTO agent_role_catalog ...`
 * 一次性写入，运行时**从未**被任何代码修改 —— `defaultPromptTemplate` 列 22 行全部
 * 空字符串、`isBuiltin` 全部 true。
 *
 * 收敛动机（详见 docs canvas `qubit-architecture-and-redundancy.canvas.tsx` C9）：
 *   - 写入端 = 仅 SQL 种子，零运行时 insert/update
 *   - 读取端 = 仅 `GET /api/v1/analyst/roles` 一个端点
 *   - 前端 = 声明了 `AgentRoleCatalogItem` + `getAgentRoles()` 但全仓零调用方
 *
 * 既然没有动态变更需求，把字典固化为代码常量；端点保留（向后兼容），改为返回
 * 这里的常量数组。
 */

export interface AgentRoleCatalogEntry {
  role: string;
  displayName: string;
  description: string;
  team: string;
  isBuiltin: boolean;
}

export const SEED_AGENT_ROLE_CATALOG: readonly AgentRoleCatalogEntry[] = [
  // ─── V1 通用角色 ────────────────────────────────────────────────────────────
  {
    role: "orchestrator",
    displayName: "基金经理",
    description: "工作流编排与辩论主持",
    team: "ops",
    isBuiltin: true,
  },
  {
    role: "market_data",
    displayName: "行情数据员",
    description: "市场数据采集与快照",
    team: "ops",
    isBuiltin: true,
  },
  {
    role: "news_event",
    displayName: "事件追踪员",
    description: "新闻事件采集与提取",
    team: "ops",
    isBuiltin: true,
  },
  {
    role: "research",
    displayName: "研究员",
    description: "因子研究与策略迭代",
    team: "research",
    isBuiltin: true,
  },
  {
    role: "backtest",
    displayName: "回测工程师",
    description: "历史回测执行",
    team: "research",
    isBuiltin: true,
  },
  {
    role: "simulation",
    displayName: "模拟交易员",
    description: "Paper Trading 验证",
    team: "execution",
    isBuiltin: true,
  },
  {
    role: "risk",
    displayName: "风控员",
    description: "订单意图风控评估",
    team: "risk",
    isBuiltin: true,
  },
  {
    role: "execution",
    displayName: "执行员",
    description: "订单路由与经纪商接入",
    team: "execution",
    isBuiltin: true,
  },
  {
    role: "memory",
    displayName: "记忆管理员",
    description: "记忆读写与 TTL 清理",
    team: "ops",
    isBuiltin: true,
  },
  {
    role: "audit",
    displayName: "审计员",
    description: "全链路审计与报告",
    team: "ops",
    isBuiltin: true,
  },
  // ─── V2 分析师团队角色 ──────────────────────────────────────────────────────
  {
    role: "analyst_fundamental",
    displayName: "基本面研究员",
    description: "财报、估值、行业分析",
    team: "analyst",
    isBuiltin: true,
  },
  {
    role: "analyst_technical",
    displayName: "量化策略师",
    description: "K线、指标、形态分析",
    team: "analyst",
    isBuiltin: true,
  },
  {
    role: "analyst_sentiment",
    displayName: "舆情分析师",
    description: "新闻、社媒情绪分析",
    team: "analyst",
    isBuiltin: true,
  },
  {
    role: "analyst_macro",
    displayName: "宏观策略师",
    description: "宏观经济与政策面分析",
    team: "analyst",
    isBuiltin: true,
  },
  {
    role: "researcher_bull",
    displayName: "多方研究员",
    description: "多方论据汇总与推演",
    team: "researcher",
    isBuiltin: true,
  },
  {
    role: "researcher_bear",
    displayName: "空方研究员",
    description: "空方风险论据汇总",
    team: "researcher",
    isBuiltin: true,
  },
  {
    role: "risk_manager",
    displayName: "风控主管",
    description: "风控规则裁决与一票否决",
    team: "risk",
    isBuiltin: true,
  },
  {
    role: "portfolio_manager",
    displayName: "组合经理",
    description: "仓位管理与资产配置",
    team: "portfolio",
    isBuiltin: true,
  },
  {
    role: "stock_screener",
    displayName: "量化选股助手",
    description: "条件过滤与综合评分",
    team: "research",
    isBuiltin: true,
  },
  {
    role: "backtest_engineer",
    displayName: "量化工程师",
    description: "策略回测与绩效评估",
    team: "research",
    isBuiltin: true,
  },
  {
    role: "execution_trader",
    displayName: "交易员",
    description: "订单拆分与择时下单",
    team: "execution",
    isBuiltin: true,
  },
  {
    role: "memory_curator",
    displayName: "知识管理员",
    description: "研究成果归档与知识库维护",
    team: "ops",
    isBuiltin: true,
  },
] as const;
