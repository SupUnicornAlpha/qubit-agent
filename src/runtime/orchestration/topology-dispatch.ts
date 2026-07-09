import { asc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition } from "../../db/sqlite/schema";
import type { AgentRole } from "../../types/entities";

export const TOPOLOGY_TEAM_TOOL_PREFIX = "call_team_";

/** 已合并/退役角色 → 当前内置角色（派单兼容） */
export const DISPATCH_ROLE_ALIASES: Partial<Record<AgentRole, AgentRole>> = {
  risk_manager: "risk",
  researcher_bull: "research",
  researcher_bear: "research",
  backtest_engineer: "backtest",
  execution_trader: "execution",
  memory_curator: "memory",
};

const SPECIALIST_ROLE_PRIORITY: readonly AgentRole[] = [
  "market_data",
  "news_event",
  "analyst_macro",
  "analyst_fundamental",
  "analyst_technical",
  "analyst_sentiment",
  "research",
  "backtest",
  "risk",
  "portfolio_manager",
  "execution",
  "memory",
] as const;

const SPECIALIST_ROLE_PRIORITY_INDEX = new Map(
  SPECIALIST_ROLE_PRIORITY.map((role, index) => [role, index])
);

export function resolveDispatchRole(role: AgentRole): AgentRole {
  return DISPATCH_ROLE_ALIASES[role] ?? role;
}

export type TopologyDispatchTarget = {
  role: AgentRole;
  toolName: string;
  agentName: string;
  definitionId: string;
  enabled: boolean;
};

export type OrchestratorTopologyContext = {
  groupId: null;
  edges: [];
  targets: TopologyDispatchTarget[];
  toolNames: string[];
};

export function topologyTeamToolName(role: AgentRole): string {
  return `${TOPOLOGY_TEAM_TOOL_PREFIX}${role}`;
}

export function topologyTeamToolDescription(role: AgentRole, agentName?: string): string {
  const label = agentName ? `${agentName}（${role}）` : role;
  return `向 ${label} 派发任务（Graph/A2A）；参数 goal 必填`;
}

export function isTopologyTeamTool(toolName: string): boolean {
  return toolName.startsWith(TOPOLOGY_TEAM_TOOL_PREFIX);
}

export function parseRoleFromTopologyTeamTool(toolName: string): AgentRole | null {
  if (!isTopologyTeamTool(toolName)) return null;
  const role = toolName.slice(TOPOLOGY_TEAM_TOOL_PREFIX.length);
  return role.length > 0 ? (role as AgentRole) : null;
}

export async function loadOrchestratorTopologyForWorkflow(): Promise<OrchestratorTopologyContext> {
  const db = await getDb();
  const rows = await db
    .select({
      id: agentDefinition.id,
      role: agentDefinition.role,
      name: agentDefinition.name,
      enabled: agentDefinition.enabled,
    })
    .from(agentDefinition)
    .where(eq(agentDefinition.enabled, true))
    .orderBy(asc(agentDefinition.role), asc(agentDefinition.name));

  const byRole = new Map<AgentRole, TopologyDispatchTarget>();
  for (const row of rows) {
    const role = row.role as AgentRole;
    if (role === "orchestrator") continue;
    const resolvedRole = resolveDispatchRole(role);
    if (resolvedRole === "orchestrator") continue;
    if (byRole.has(resolvedRole)) continue;
    byRole.set(resolvedRole, {
      role: resolvedRole,
      toolName: topologyTeamToolName(resolvedRole),
      agentName: row.name,
      definitionId: row.id,
      enabled: true,
    });
  }

  const targets = [...byRole.values()].sort((a, b) => {
    const ai = SPECIALIST_ROLE_PRIORITY_INDEX.get(a.role) ?? Number.MAX_SAFE_INTEGER;
    const bi = SPECIALIST_ROLE_PRIORITY_INDEX.get(b.role) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.role.localeCompare(b.role);
  });

  return {
    groupId: null,
    edges: [],
    targets,
    toolNames: targets.map((target) => target.toolName),
  };
}

/** 非 Orchestrator 专家：协作边界（不需完整拓扑表） */
export function buildAgentCollaborationHint(role: AgentRole): string {
  if (role === "orchestrator") return "";
  return [
    "## 协作边界",
    "- 你由 **Orchestrator** 通过 `call_team_<role>` 或 `TASK_ASSIGN` 调度；专注本子任务。",
    "- 勿擅自代替其他 Agent 执行工作或编造其结论。",
    "- 默认只返回完成当前子任务所需的最小结果：结论、关键证据、未决风险；除非明确要求，不要展开成长报告。",
    "- 产出供 Orchestrator 汇总：中文、可追溯、不确定处标注 `[待核实]`。",
  ].join("\n");
}

export function buildTopologyToolsPromptBlock(ctx: OrchestratorTopologyContext | null): string {
  if (!ctx || ctx.targets.length === 0) {
    return [
      "## 专家调度",
      "当前没有可用专家工具；请使用 `assign_task` 按需派给具体专家角色。",
    ].join("\n");
  }

  const lines: string[] = [
    "## 专家调度工具",
    "下面是当前已启用专家的直接派单工具。调用后系统会向该角色发起 Graph/A2A 任务（`TASK_ASSIGN`）。",
    "传参：`goal`（必填）、`message`（可选补充）、`taskType`（默认 `topology_dispatch`）、`params`（可选 JSON 对象）。",
    "",
    "| 工具名 | 目标角色 | 说明 |",
    "|--------|----------|------|",
  ];

  for (const target of ctx.targets) {
    lines.push(`| \`${target.toolName}\` | ${target.role}（${target.agentName}） | 已启用 |`);
  }

  lines.push(
    "",
    "规则：",
    "- 优先用上表中的 `call_team_<role>` 做**定向派单**。",
    "- 由 **Orchestrator 统一派单和收口**；不要让专家再组织其它专家。",
    "- `assign_task` 仅当目标不在上表时使用。",
    "- 默认先补数据，再补分析/研究，再决定是否回测与风控。",
    "- 默认拿到足够证据就收口，不要为了“完整报告”把所有角色都跑一遍。"
  );

  return lines.join("\n");
}

export function buildSuggestedCallChainBlock(ctx: OrchestratorTopologyContext | null): string {
  if (!ctx || ctx.targets.length === 0) {
    return [
      "## 建议的调用链（仅供参考）",
      "当前没有预设专家工具链。你自主决定调用哪些专家：用 `assign_task` 派给任意已启用角色，由你统一整合，不要默认批量拉全队。",
    ].join("\n");
  }

  const chain = ctx.targets
    .slice(0, 8)
    .map(
      (target, index) =>
        `${index + 1}. \`${target.toolName}\`（${target.role} / ${target.agentName}）`
    )
    .join("  →  ");

  return [
    "## 建议的调用链（来自当前启用专家 · 仅供参考 · 非强制）",
    "你是决策者：可以按需调用、跳过某步、或补充其它角色；原则是少而精，不默认批量拉全队。",
    "",
    `推荐顺序：${chain}`,
    "",
    "推荐阶段：先数据/事件，再专项分析，再 research → backtest → risk。",
    "原则：能少调就少调，信息够了就收口给用户；开工前用 `update_plan` 把你选定的链落成对用户可见的计划，每步完成即更新。",
  ].join("\n");
}

export function assertTopologyTargetAllowed(
  ctx: OrchestratorTopologyContext | null,
  role: AgentRole
): void {
  if (!ctx || ctx.targets.length === 0) return;
  const allowed = ctx.targets.some((target) => target.role === role);
  if (!allowed) {
    throw new Error(`role '${role}' is not in the current enabled specialist set`);
  }
}

/** Orchestrator 静态基础工具（不含专家派单工具） */
export const ORCHESTRATOR_BASE_TOOLS = [
  "assign_task",
  "evaluate_risk",
  "edit_agent_pack",
  "call_mcp",
] as const;

export function mergeOrchestratorToolsJson(topologyToolNames: string[]): string[] {
  return [...new Set([...ORCHESTRATOR_BASE_TOOLS, ...topologyToolNames])];
}

export function stripTopologyToolsFromList(tools: string[]): string[] {
  return tools.filter((tool) => !isTopologyTeamTool(tool));
}
