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

/** 默认编排团队（10 成员 = Orchestrator + 9 专家） */
export const DEFAULT_ORCHESTRATION_GROUP = {
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
  ] as const,
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
  ] as const,
};

export const ROLE_SKILLS: Partial<Record<AgentRole, string[]>> = {
  orchestrator: skills(S.compsAnalysis),
  market_data: skills(),
  news_event: skills("sentiment-analysis", S.earningsPreview),
  research: skills(
    "momentum-factor",
    "fundamental-analysis",
    S.dcfModel,
    S.compsAnalysis,
    S.xlsxAuthor,
    S.ideaGeneration,
    S.competitiveAnalysis
  ),
  backtest: skills(S.auditXls, "technical-analysis"),
  risk: skills("risk-management"),
  analyst_fundamental: skills(
    "fundamental-analysis",
    S.compsAnalysis,
    S.competitiveAnalysis,
    S.dcfModel
  ),
  analyst_technical: skills("technical-analysis"),
  analyst_sentiment: skills(
    "sentiment-analysis",
    S.earningsAnalysis,
    S.modelUpdate,
    S.morningNote
  ),
  analyst_macro: skills("macro-analysis", S.sectorOverview, S.initiatingCoverage),
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
