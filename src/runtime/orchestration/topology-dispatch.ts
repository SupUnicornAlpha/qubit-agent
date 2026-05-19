import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentGroup, agentGroupMember, workflowRun } from "../../db/sqlite/schema";
import type { AgentRole } from "../../types/entities";
import { DEFAULT_ORCHESTRATION_GROUP } from "../seed-agent-catalog";
import { parseTeamRelations, type TeamRelationEdge } from "../msa/analyst-team-topology";

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
  groupId: string;
  edges: TeamRelationEdge[];
  targets: TopologyDispatchTarget[];
  toolNames: string[];
};

export function topologyTeamToolName(role: AgentRole): string {
  return `${TOPOLOGY_TEAM_TOOL_PREFIX}${role}`;
}

export function topologyTeamToolDescription(role: AgentRole, agentName?: string): string {
  const label = agentName ? `${agentName}（${role}）` : role;
  return `按编组拓扑向 ${label} 派发任务（Graph/A2A）；参数 goal 必填`;
}

export function isTopologyTeamTool(toolName: string): boolean {
  return toolName.startsWith(TOPOLOGY_TEAM_TOOL_PREFIX);
}

export function parseRoleFromTopologyTeamTool(toolName: string): AgentRole | null {
  if (!isTopologyTeamTool(toolName)) return null;
  const role = toolName.slice(TOPOLOGY_TEAM_TOOL_PREFIX.length);
  return role.length > 0 ? (role as AgentRole) : null;
}

/** Orchestrator 出边（含双向：画布上专家 → orchestrator 的回报边不生成调用工具） */
export function parseOrchestratorOutboundEdges(
  relationsJson: unknown,
  memberRoles: AgentRole[]
): TeamRelationEdge[] {
  const allow = new Set(memberRoles);
  if (!allow.has("orchestrator")) return [];
  const all = parseTeamRelations(relationsJson, memberRoles);
  return all.filter((e) => e.from === "orchestrator" && e.to !== "orchestrator");
}

export async function loadOrchestratorTopologyForGroup(
  groupId: string
): Promise<OrchestratorTopologyContext | null> {
  const db = await getDb();
  const grp = await db.select().from(agentGroup).where(eq(agentGroup.id, groupId)).limit(1);
  if (!grp[0]) return null;

  const members = await db
    .select({
      role: agentDefinition.role,
      name: agentDefinition.name,
      definitionId: agentDefinition.id,
      enabled: agentDefinition.enabled,
    })
    .from(agentGroupMember)
    .innerJoin(agentDefinition, eq(agentGroupMember.definitionId, agentDefinition.id))
    .where(eq(agentGroupMember.groupId, groupId));

  const memberRoles = members.map((m) => m.role as AgentRole);
  const edges = parseOrchestratorOutboundEdges(grp[0].relationsJson, memberRoles);

  const roleMeta = new Map(
    members.map((m) => [m.role as AgentRole, { name: m.name, definitionId: m.definitionId, enabled: m.enabled }])
  );

  const targets: TopologyDispatchTarget[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (seen.has(e.to)) continue;
    seen.add(e.to);
    const meta = roleMeta.get(e.to);
    if (!meta) continue;
    targets.push({
      role: e.to,
      toolName: topologyTeamToolName(e.to),
      agentName: meta.name,
      definitionId: meta.definitionId,
      enabled: Boolean(meta.enabled),
    });
  }

  return {
    groupId,
    edges,
    targets,
    toolNames: targets.map((t) => t.toolName),
  };
}

export async function loadOrchestratorTopologyForWorkflow(
  workflowId: string
): Promise<OrchestratorTopologyContext | null> {
  const db = await getDb();
  const wf = await db
    .select({ agentGroupId: workflowRun.agentGroupId })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  const groupId = wf[0]?.agentGroupId ?? DEFAULT_ORCHESTRATION_GROUP.id;
  return loadOrchestratorTopologyForGroup(groupId);
}

/** 非 Orchestrator 专家：协作边界（不需完整拓扑表） */
export function buildAgentCollaborationHint(role: AgentRole): string {
  if (role === "orchestrator") return "";
  return [
    "## 协作边界",
    "- 你由 **Orchestrator** 通过编组拓扑（`call_team_<role>`）或 `TASK_ASSIGN` 调度；专注本子任务。",
    "- 勿擅自代替其他 Agent 执行工作或编造其结论。",
    "- 产出供 Orchestrator 汇总：中文、可追溯、不确定处标注 `[待核实]`。",
  ].join("\n");
}

export function buildTopologyToolsPromptBlock(ctx: OrchestratorTopologyContext | null): string {
  if (!ctx || ctx.targets.length === 0) {
    return [
      "## 团队拓扑调度",
      "当前工作流未配置从 orchestrator 出发的拓扑边；可使用 `assign_task`（目标角色须已启用）或 `run_analyst_team`。",
    ].join("\n");
  }

  const lines: string[] = [
    "## 团队拓扑调度（仅可调用下列工具派单）",
    "每条出边对应一个工具名；调用后系统会向该角色发起 Graph/A2A 任务（`TASK_ASSIGN`）。",
    "传参：`goal`（必填）、`message`（可选补充）、`taskType`（默认 `topology_dispatch`）、`params`（可选 JSON 对象）。",
    "",
    "| 工具名 | 目标角色 | 说明 |",
    "|--------|----------|------|",
  ];

  for (const t of ctx.targets) {
    const status = t.enabled ? "已启用" : "已禁用（调用将失败）";
    lines.push(`| \`${t.toolName}\` | ${t.role}（${t.agentName}） | ${status} |`);
  }

  lines.push(
    "",
    "规则：",
    "- **优先**使用上表中的 `call_team_<role>`，与编组画布拓扑一致。",
    "- `run_analyst_team` 仍用于一次性启动四维分析师 MSA（编组内 analyst_*）。",
    "- `assign_task` 仅当目标不在上表时使用。",
    "- 按拓扑阶段顺序派发：数据层 → 分析师/研究 → 回测 → 风控。"
  );

  return lines.join("\n");
}

/** Orchestrator 静态基础工具（不含拓扑边，拓扑工具由 sync 写入 DB） */
export const ORCHESTRATOR_BASE_TOOLS = [
  "task_decompose",
  "assign_task",
  "run_analyst_team",
  "fuse_signals",
  "check_risk",
  "edit_agent_pack",
  "call_mcp",
] as const;

export function mergeOrchestratorToolsJson(topologyToolNames: string[]): string[] {
  return [...new Set([...ORCHESTRATOR_BASE_TOOLS, ...topologyToolNames])];
}

export function stripTopologyToolsFromList(tools: string[]): string[] {
  return tools.filter((t) => !isTopologyTeamTool(t));
}

export function assertTopologyTargetAllowed(
  ctx: OrchestratorTopologyContext | null,
  role: AgentRole
): void {
  if (!ctx || ctx.targets.length === 0) return;
  const allowed = ctx.targets.some((t) => t.role === role);
  if (!allowed) {
    throw new Error(
      `Role "${role}" is not on an orchestrator outbound topology edge in group ${ctx.groupId}. ` +
        `Allowed: ${ctx.targets.map((t) => t.role).join(", ")}`
    );
  }
}
