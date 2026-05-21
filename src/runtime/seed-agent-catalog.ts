/**
 * 内置 Agent 的 Skills / MCP 目录（含 FSI 内容包 id）。
 * 主提示词见 seed-agent-prompts.ts；此处仅资源清单。
 */

import type { AgentRole } from "../types/entities";
import { RECOMMENDED_MCP_NAMES } from "./seed-recommended-mcp-servers";

/** 量化平台通用 MCP（math / financex 等） */
export const QUANT_MCP = [
  RECOMMENDED_MCP_NAMES.MATHJS,
  RECOMMENDED_MCP_NAMES.TRADINGCALC,
  RECOMMENDED_MCP_NAMES.FINANCEX,
] as const;

/** FSI 机构数据 MCP（DB 中默认 disabled，配置 URL 后启用） */
export const FSI_DATA_MCP = [
  "fsi-factset",
  "fsi-daloopa",
  "fsi-sp-global",
  "fsi-aiera",
  "fsi-mtnewswires",
] as const;

export const FSI_SKILLS = {
  earningsAnalysis: "fsi/earnings-analysis",
  earningsPreview: "fsi/earnings-preview",
  sectorOverview: "fsi/sector-overview",
  initiatingCoverage: "fsi/initiating-coverage",
  modelUpdate: "fsi/model-update",
  morningNote: "fsi/morning-note",
  thesisTracker: "fsi/thesis-tracker",
  ideaGeneration: "fsi/idea-generation",
  compsAnalysis: "fsi/comps-analysis",
  dcfModel: "fsi/dcf-model",
  auditXls: "fsi/audit-xls",
  xlsxAuthor: "fsi/xlsx-author",
  cleanDataXls: "fsi/clean-data-xls",
  competitiveAnalysis: "fsi/competitive-analysis",
  kycRules: "fsi/kyc-rules",
  kycDocParse: "fsi/kyc-doc-parse",
  glRecon: "fsi/gl-recon",
} as const;

const S = FSI_SKILLS;

/** 内置 skill + FSI skill（去重） */
export function skills(...ids: string[]): string[] {
  return [...new Set(ids.filter(Boolean))];
}

export function mcpServers(...names: string[]): string[] {
  return [...new Set(names)];
}

/** 挂载量化 MCP 的角色（与 SEED 10 人 roster 对齐） */
export const QUANT_MCP_ROLES = new Set<AgentRole>([
  "orchestrator",
  "market_data",
  "news_event",
  "research",
  "backtest",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "risk",
]);

/** 可挂载 FSI 机构 MCP 的角色 */
export const FSI_MCP_ROLES = new Set<AgentRole>([
  "orchestrator",
  "research",
  "analyst_fundamental",
  "analyst_sentiment",
  "analyst_macro",
  "news_event",
]);

export function resolveSeedMcpServers(role: AgentRole, base: string[]): string[] {
  const out = [...base];
  if (QUANT_MCP_ROLES.has(role)) {
    for (const n of QUANT_MCP) if (!out.includes(n)) out.push(n);
  }
  if (FSI_MCP_ROLES.has(role)) {
    for (const n of FSI_DATA_MCP) if (!out.includes(n)) out.push(n);
  }
  return out;
}

export type BuiltinAgentGroupSpec = {
  id: string;
  name: string;
  description: string;
  memberDefinitionIds: readonly string[];
  memberRoles: readonly AgentRole[];
};

/** 默认编排团队（10 成员 = Orchestrator + 9 专家） */
export const DEFAULT_ORCHESTRATION_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-default-analyst-team",
  name: "默认编排团队（10 Agent）",
  description:
    "Orchestrator 统筹：数据层 → 四维分析师 MSA → 策略/回测 → 统一风控（规则+组合）。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-market-data",
    "def-news-event",
    "def-analyst-fundamental",
    "def-analyst-technical",
    "def-analyst-sentiment",
    "def-analyst-macro",
    "def-research",
    "def-backtest",
    "def-risk",
  ],
  memberRoles: [
    "orchestrator",
    "market_data",
    "news_event",
    "analyst_fundamental",
    "analyst_technical",
    "analyst_sentiment",
    "analyst_macro",
    "research",
    "backtest",
    "risk",
  ],
};

/** 全分析师编组：四维 MSA + 多空博弈，不进入策略/回测 */
export const FULL_ANALYST_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-full-analyst-team",
  name: "全分析师（MSA + 辩论）",
  description:
    "Orchestrator + 四维分析师：宏观→基本面→技术面→情绪面串行加深，MSA 融合与多空辩论；不含策略撰写。完成后再选「策略撰写」编组接续。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-analyst-fundamental",
    "def-analyst-technical",
    "def-analyst-sentiment",
    "def-analyst-macro",
  ],
  memberRoles: [
    "orchestrator",
    "analyst_fundamental",
    "analyst_technical",
    "analyst_sentiment",
    "analyst_macro",
  ],
};

/** 策略撰写编组：MSA/辩论之后专门产出可回测策略 */
export const STRATEGY_PIPELINE_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-strategy-pipeline",
  name: "策略撰写（研究→回测→风控）",
  description:
    "Orchestrator + research/backtest/risk：基于上游研究报告或本页「补充上下文」直接进入策略撰写与回测，跳过 proceedToStrategy 闸门。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-research",
    "def-backtest",
    "def-risk",
  ],
  memberRoles: ["orchestrator", "research", "backtest", "risk"],
};

// ─── M1：研究场景化新增编组（详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.6.4） ───
// 复用已有 22 个 AgentRole；不实装专门 handler 的角色用通用 ReAct
// 各场景的 inputSchema / 工具 preset / Provider 需求由 research_scenario 表承载

/** 因子研究：orchestrator + research + 两个分析师，配 factor.* 工具 */
export const FACTOR_RESEARCH_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-factor-research",
  name: "因子研究",
  description:
    "围绕目标因子类别生成候选因子、计算因子值、评估 IC/IR、入库为可复用因子。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-research",
    "def-analyst-fundamental",
    "def-analyst-technical",
  ],
  memberRoles: [
    "orchestrator",
    "research",
    "analyst_fundamental",
    "analyst_technical",
  ],
};

/** 规则研究：orchestrator + research + risk_manager */
export const RULE_RESEARCH_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-rule-research",
  name: "规则研究",
  description: "基于现有因子库生成可解释的 JSON-DSL 规则并入库。",
  memberDefinitionIds: ["def-orchestrator", "def-research", "def-risk"],
  memberRoles: ["orchestrator", "research", "risk_manager"],
};

/** 选股研究：orchestrator + stock_screener + 两个分析师 */
export const STOCK_SCREENING_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-stock-screening",
  name: "选股研究",
  description: "基于因子打分与规则过滤产出候选股池。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-research",
    "def-analyst-fundamental",
    "def-analyst-sentiment",
  ],
  memberRoles: [
    "orchestrator",
    "stock_screener",
    "analyst_fundamental",
    "analyst_sentiment",
  ],
};

/** 风控审查：orchestrator + risk_manager + audit */
export const RISK_REVIEW_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-risk-review",
  name: "风控审查",
  description: "审查策略历史与现有限额，产出新的风控规则建议。",
  memberDefinitionIds: ["def-orchestrator", "def-risk", "def-research"],
  memberRoles: ["orchestrator", "risk_manager", "audit"],
};

/** PM 组合管理：orchestrator + portfolio_manager + risk_manager + research */
export const PORTFOLIO_MANAGEMENT_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-portfolio-management",
  name: "PM 组合管理",
  description: "多策略权重分配、再平衡方案、暴露报告。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-research",
    "def-risk",
    "def-backtest",
  ],
  memberRoles: ["orchestrator", "portfolio_manager", "risk_manager", "research"],
};

/** 因子/规则/策略 挖掘：orchestrator + research + backtest_engineer */
export const DISCOVERY_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-discovery",
  name: "因子/规则/策略 挖掘",
  description:
    "自动生成候选因子+规则+策略，演化筛选 Sharpe>阈值 的优胜者，入库到 gene pool。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-research",
    "def-backtest",
  ],
  memberRoles: ["orchestrator", "research", "backtest_engineer"],
};

/** 实盘交易：orchestrator + execution_trader + risk_manager */
export const LIVE_TRADING_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-live-trading",
  name: "实盘交易",
  description: "实盘下单、监控、风控记录；走 Live 闸门与 HMAC 签名。",
  memberDefinitionIds: ["def-orchestrator", "def-risk"],
  memberRoles: ["orchestrator", "execution_trader", "risk_manager"],
};

/** 复盘归因：orchestrator + research + analyst_macro */
export const POSTMORTEM_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-postmortem",
  name: "复盘归因",
  description: "因子归因 / 行业归因 / 事件归因，输出复盘报告。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-research",
    "def-analyst-macro",
  ],
  memberRoles: ["orchestrator", "research", "analyst_macro"],
};

/** 事件雷达：orchestrator + news_event + analyst_sentiment */
export const NEWS_EVENT_RADAR_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-news-event-radar",
  name: "事件雷达",
  description: "扫描新闻流，识别可交易事件，输出影响评估与预警。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-news-event",
    "def-analyst-sentiment",
  ],
  memberRoles: ["orchestrator", "news_event", "analyst_sentiment"],
};

export const BUILTIN_AGENT_GROUPS: readonly BuiltinAgentGroupSpec[] = [
  DEFAULT_ORCHESTRATION_GROUP,
  FULL_ANALYST_GROUP,
  STRATEGY_PIPELINE_GROUP,
  // M1 新增 9 个场景化编组
  FACTOR_RESEARCH_GROUP,
  RULE_RESEARCH_GROUP,
  STOCK_SCREENING_GROUP,
  RISK_REVIEW_GROUP,
  PORTFOLIO_MANAGEMENT_GROUP,
  DISCOVERY_GROUP,
  LIVE_TRADING_GROUP,
  POSTMORTEM_GROUP,
  NEWS_EVENT_RADAR_GROUP,
];

export const ROLE_SKILLS: Partial<Record<AgentRole, string[]>> = {
  orchestrator: skills(S.compsAnalysis, S.thesisTracker),
  market_data: skills(S.cleanDataXls),
  news_event: skills("sentiment-analysis", S.earningsPreview, S.morningNote),
  research: skills(
    "momentum-factor",
    "fundamental-analysis",
    S.dcfModel,
    S.compsAnalysis,
    S.xlsxAuthor,
    S.ideaGeneration,
    S.competitiveAnalysis,
    /** M9.P3：研究产出长期跟踪 */
    S.thesisTracker
  ),
  backtest: skills(
    S.auditXls,
    "technical-analysis",
    /** M9.P3：回测前要做数据清洗 */
    S.cleanDataXls
  ),
  risk: skills(
    "risk-management",
    /** M9.P3：风控也覆盖 KYC/合规规则 */
    S.kycRules
  ),
  analyst_fundamental: skills(
    "fundamental-analysis",
    S.compsAnalysis,
    S.competitiveAnalysis,
    S.dcfModel,
    /** M9.P3：财报准入与持续跟踪 */
    S.earningsPreview,
    S.thesisTracker
  ),
  analyst_technical: skills(
    "technical-analysis",
    /** M9.P3：技术面也是动量因子家族最常用 */
    "momentum-factor"
  ),
  analyst_sentiment: skills(
    "sentiment-analysis",
    S.earningsAnalysis,
    S.earningsPreview,
    S.modelUpdate,
    S.morningNote
  ),
  analyst_macro: skills(
    "macro-analysis",
    S.sectorOverview,
    S.initiatingCoverage,
    /** M9.P3：宏观也用 morning-note 输出格式 */
    S.morningNote
  ),
};

export const ROLE_CONNECTOR_MCPS: Partial<Record<AgentRole, string[]>> = {
  orchestrator: [],
  market_data: ["qubit-data"],
  news_event: ["qubit-news"],
  research: ["qubit-data", "qubit-research"],
  backtest: ["qubit-data", "qubit-backtest"],
  risk: ["qubit-risk"],
  analyst_fundamental: ["qubit-data"],
  analyst_technical: ["qubit-data", "qubit-backtest"],
  analyst_sentiment: ["qubit-news"],
  analyst_macro: ["qubit-data"],
};
