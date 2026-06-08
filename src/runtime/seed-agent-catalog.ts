/**
 * 内置 Agent 的 Skills / MCP 目录（含 FSI 内容包 id）。
 * 主提示词见 seed-agent-prompts.ts；此处仅资源清单。
 */

import type { AgentRole } from "../types/entities";
import type { AgentOutput } from "./types";
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

/**
 * 编组的 dispatch 模式（migration 0073）。
 *
 * Dispatcher（src/runtime/msa/analyst-team.ts 及未来同类 runner）按这个枚举决定
 * 如何编排 memberRoles 的产出。**新增 group 时必须显式指定**——避免再次落入
 * "硬编码 isMsAnalystRole 把非 4 类 analyst_* 偷偷丢弃" 的历史坑。
 *
 *   - 'msa_fusion'           Orchestrator + 4 类 analyst_* → MSA 信号融合 →
 *                            可选 aux post-fusion（research/backtest/risk）。
 *                            **当前默认行为**；适合单标 / 篮子的多视角共识。
 *
 *   - 'sequential_research'  按 memberRoles 顺序串行执行，无 MSA 投票。
 *                            适合：strategy_pipeline (research→backtest→risk)、
 *                            postmortem (research+macro 归因)、
 *                            screening (research+2 分析师选股) 等无需信号汇总的链条。
 *
 *   - 'event_radar'          events 角色（news_event）主导扫描，signal 角色
 *                            （analyst_sentiment）辅助评估市场情绪。
 *                            产出 events[] + report，不参与 MSA fusion。
 *
 *   - 'factor_discovery'     research → factor_candidates → backtest_results
 *                            的特化串行；包含 walk-forward 验证师把关。
 */
export type AgentGroupPipelineKind =
  | "msa_fusion"
  | "sequential_research"
  | "event_radar"
  | "factor_discovery";

export type BuiltinAgentGroupSpec = {
  id: string;
  name: string;
  description: string;
  memberDefinitionIds: readonly string[];
  memberRoles: readonly AgentRole[];
  /**
   * 编组的 dispatch 模式（migration 0073）。落 `agent_group.pipeline_kind` 列。
   * 详见 `AgentGroupPipelineKind` JSDoc。
   */
  pipelineKind: AgentGroupPipelineKind;
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
  pipelineKind: "msa_fusion",
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
  pipelineKind: "msa_fusion",
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
  pipelineKind: "sequential_research",
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
  /**
   * 注意：本编组只做"候选因子 + 同行评审"，**不跑 backtest**（无 def-backtest 成员）。
   * 因此 pipelineKind 是 sequential_research 而非 factor_discovery
   * （后者要求成员包含 backtest_results 产出者，由 grp-discovery 承担）。
   */
  pipelineKind: "sequential_research",
};

/**
 * 规则研究：orchestrator + research + risk。
 *
 * 评估报告 P2-F：原 memberRoles 写 `risk_manager` 与 memberDefinitionIds 里的
 * `def-risk` 不一致——M9.P5 起 risk_manager role 已并入 risk（统一风控）。
 * 这种错位会让前端选编组 UI 显示"risk_manager"但实际跑的是 def-risk，
 * 让用户以为有两个风险 agent。
 */
export const RULE_RESEARCH_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-rule-research",
  name: "规则研究",
  description: "基于现有因子库生成可解释的 JSON-DSL 规则并入库。",
  memberDefinitionIds: ["def-orchestrator", "def-research", "def-risk"],
  memberRoles: ["orchestrator", "research", "risk"],
  pipelineKind: "sequential_research",
};

/**
 * 选股研究：orchestrator + research + 两个分析师。
 *
 * 评估报告 P2-F：原 memberRoles 写 `stock_screener` 与 memberDefinitionIds 里
 * 的 `def-research` 不一致——stock_screener role 已在 RETIRED_BUILTIN_DEFINITION_IDS
 * 里（M9.P5 选股职能并入 research：factor.list + discovery.run + universe）。
 */
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
    "research",
    "analyst_fundamental",
    "analyst_sentiment",
  ],
  pipelineKind: "sequential_research",
};

/**
 * 风控审查：orchestrator + risk + research。
 *
 * 评估报告 P2-F：原 memberRoles 写 `risk_manager` + `audit`，与 memberDefinitionIds
 * 里 `def-risk` + `def-research` 不一致——audit role 已在 RETIRED_BUILTIN_DEFINITION_IDS
 * 里（合规审计并入 monitor + tool-call-log-service），risk_manager 已并入 risk。
 */
export const RISK_REVIEW_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-risk-review",
  name: "风控审查",
  description: "审查策略历史与现有限额，产出新的风控规则建议。",
  memberDefinitionIds: ["def-orchestrator", "def-risk", "def-research"],
  memberRoles: ["orchestrator", "risk", "research"],
  pipelineKind: "sequential_research",
};

/**
 * PM 组合管理：orchestrator + research + risk + backtest。
 *
 * 评估报告 P2-F：原 memberRoles 包含 portfolio_manager + risk_manager 两个
 * 退役 role，与 memberDefinitionIds 完全不对齐。M9.P5 起 PM 职能并入
 * research（仓位决策 / 再平衡方案）+ risk（暴露限额签核），不再有专门 PM
 * agent；如需独立 PM 维度，后续可新建 def 但不要复活旧 stub。
 */
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
  memberRoles: ["orchestrator", "research", "risk", "backtest"],
  pipelineKind: "sequential_research",
};

/** 因子/规则/策略 挖掘：orchestrator + research + backtest_engineer */
export const DISCOVERY_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-discovery",
  name: "因子/规则/策略 挖掘",
  description:
    "自动生成候选因子+规则+策略，演化筛选 Sharpe>阈值 的优胜者，入库到 gene pool。" +
    "M9.P5：含专项 walk-forward 验证师，对候选必须跑 cross-regime + walk-forward 才能入库。",
  memberDefinitionIds: [
    "def-orchestrator",
    "def-research",
    "def-backtest",
    /** M9.P5: 专项 walk-forward / regime 验证师 */
    "def-walk-forward-validator",
  ],
  memberRoles: ["orchestrator", "research", "backtest", "backtest_engineer"],
  pipelineKind: "factor_discovery",
};

/**
 * 实盘交易：orchestrator + research + risk。
 *
 * 评估报告 P2-F：原 memberRoles 写 execution_trader + risk_manager 都是退役
 * role，且与 memberDefinitionIds 完全不一致——def-execution-trader 已退役，
 * 当前实盘路径走的是 risk 签核 + monitor 兜底；如需重建实盘 agent，请新建 def。
 *
 * 2026-06-08 P0-1.c (Round 6 复盘)：旧成员只有 orchestrator + risk，Round 6 实测
 * 整个团队 4 step 就停，0 个 order_intent 落库——风险评估完没人下单。
 * 现加入 def-research：研究员在 paper mode 下用 order.create_intent 落单（risk
 * 仍负责签核 + pre-trade 检查），完成"研究 → 风控 → 下单"完整链路。
 */
export const LIVE_TRADING_GROUP: BuiltinAgentGroupSpec = {
  id: "grp-live-trading",
  name: "实盘交易",
  description:
    "research 负责 strategy.create_version + order.create_intent 下单；risk 负责签核与 pre-trade 风险检查。默认走 paper（dispatch_mode='paper'），实盘前必须人工 review。",
  memberDefinitionIds: ["def-orchestrator", "def-research", "def-risk"],
  memberRoles: ["orchestrator", "research", "risk"],
  pipelineKind: "sequential_research",
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
  pipelineKind: "sequential_research",
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
  pipelineKind: "event_radar",
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

/**
 * 角色产出能力默认映射（migration 0073）。
 *
 * Dispatcher（src/runtime/msa/analyst-team.ts 等）按 def.outputs 分桶——取代
 * 三套硬编码 set（RESEARCH_TEAM_SLOT_SET / isMsAnalystRole / POST_FUSION_AUX_ROLES）。
 *
 * 单个 def 在 `seed-agent-definitions-data.ts` 中如果未显式传 outputs，
 * 由 `def()` helper 从这里读 fallback。完全没声明（如未来第三方 def）
 * 则等同于 `[]`，dispatcher 走 role-name 老 fallback（兼容路径）。
 *
 * 取值含义详见 src/runtime/types.ts `AgentOutput`。
 */
export const ROLE_OUTPUTS: Partial<Record<AgentRole, readonly AgentOutput[]>> = {
  orchestrator: [],
  market_data: ["report"],
  news_event: ["events", "report"],
  analyst_fundamental: ["signal", "report"],
  analyst_technical: ["signal", "report"],
  analyst_sentiment: ["signal", "report"],
  analyst_macro: ["signal", "report"],
  research: ["report", "factor_candidates", "strategy_dsl"],
  backtest: ["backtest_results", "report"],
  risk: ["risk_assessment", "report"],
  backtest_engineer: ["backtest_results", "report"],
};
