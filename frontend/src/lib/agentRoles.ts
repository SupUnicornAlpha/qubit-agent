/**
 * 配置中心「新建 Agent」可选角色：与当前产品主路径（研究团队 + 编排）对齐。
 * 完整枚举见后端 `ALL_AGENT_ROLES`；未列入的角色仍可通过 API 使用内置 `def-*` 定义。
 */
export const AGENT_ROLE_OPTIONS = [
  "orchestrator",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "analyst_macro",
  "research",
  "backtest",
  "risk",
  "risk_manager",
] as const;

export type AgentRoleOption = (typeof AGENT_ROLE_OPTIONS)[number];

/** 内置种子 definition id 前缀，UI 删除按钮据此隐藏 */
export const BUILTIN_AGENT_DEFINITION_ID_PREFIX = "def-";

export function isBuiltinAgentDefinitionId(id: string): boolean {
  return id.startsWith(BUILTIN_AGENT_DEFINITION_ID_PREFIX);
}
