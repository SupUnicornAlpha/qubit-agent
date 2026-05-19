/**
 * 研究团队可选槽位（与后端 `RESEARCH_TEAM_SLOT_ROLES` 保持一致）。
 * analyst_* 参与 MSA 信号融合；其余角色产出 Markdown 辅助章节（策略/回测/风控叙事）。
 */
export const RESEARCH_TEAM_SLOT_ROLES = [
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "research",
  "backtest",
  "risk",
] as const;

export type ResearchTeamSlotRole = (typeof RESEARCH_TEAM_SLOT_ROLES)[number];

export const RESEARCH_TEAM_SLOT_ROLE_SET = new Set<string>(RESEARCH_TEAM_SLOT_ROLES);

/** 可加入研究团队编组（含 orchestrator，仅拓扑/编排展示，不参与并行分析师槽位） */
export const RESEARCH_TEAM_GROUP_POOL_ROLE_SET = new Set<string>([
  ...RESEARCH_TEAM_SLOT_ROLES,
  "orchestrator",
]);
