import type {
  AnalystTeamGraphEdge,
  AnalystTeamGraphInteraction,
  AnalystTeamGraphNode,
  AnalystTeamGraphPayload,
} from "../api/types";

export function teamGraphUndirectedKey(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

function matchesEdge(a: string, b: string, fromRole: string, toRole: string): boolean {
  return teamGraphUndirectedKey(a, b) === teamGraphUndirectedKey(fromRole, toRole);
}

/** 从交互记录聚合无向边（对话次数 / 工具次数） */
export function aggregateEdgesFromInteractions(
  interactions: AnalystTeamGraphInteraction[],
  toolCallsByRole?: Map<string, number>
): AnalystTeamGraphEdge[] {
  const map = new Map<string, { messageCount: number; toolCount: number }>();

  const bump = (x: string, y: string, msg: number, tools: number) => {
    if (!x || !y || x === y) return;
    const key = teamGraphUndirectedKey(x, y);
    const cur = map.get(key) ?? { messageCount: 0, toolCount: 0 };
    cur.messageCount += msg;
    cur.toolCount += tools;
    map.set(key, cur);
  };

  for (const row of interactions) {
    if (row.kind === "tool_call") {
      bump(row.fromRole, row.toRole, 0, 1);
    } else {
      bump(row.fromRole, row.toRole, 1, 0);
    }
  }

  if (toolCallsByRole) {
    for (const [role, n] of toolCallsByRole) {
      if (n > 0) bump(role, "__tools__", 0, n);
    }
  }

  return [...map.entries()].map(([key, agg]) => {
    const [a, b] = key.split("||");
    return { key, a, b, messageCount: agg.messageCount, toolCount: agg.toolCount };
  });
}

/**
 * 按左侧勾选的分析师过滤展示图，但保留与外部角色（如 msa）的实际通信边。
 */
/** 对话拓扑中始终展示的系统角色（不受左侧分析师勾选过滤） */
const ALWAYS_VISIBLE_GRAPH_ROLES = new Set(["orchestrator", "msa", "signal_fusion"]);

export function buildFilteredTeamGraphDisplay(
  teamGraph: AnalystTeamGraphPayload,
  participatingRoles: string[]
): AnalystTeamGraphPayload {
  if (!participatingRoles.length) return teamGraph;

  const allow = new Set(participatingRoles);
  for (const r of ALWAYS_VISIBLE_GRAPH_ROLES) allow.add(r);
  const interactions = (teamGraph.interactions ?? []).filter(
    (i) => allow.has(i.fromRole) || allow.has(i.toRole)
  );

  const nodeRoles = new Set<string>(participatingRoles);
  for (const i of interactions) {
    nodeRoles.add(i.fromRole);
    nodeRoles.add(i.toRole);
  }
  for (const t of teamGraph.toolCalls ?? []) {
    if (allow.has(t.agentRole)) nodeRoles.add(t.agentRole);
  }
  for (const m of teamGraph.mcpCalls ?? []) {
    if (allow.has(m.agentRole)) nodeRoles.add(m.agentRole);
  }

  const nodeByRole = new Map(teamGraph.nodes.map((n) => [n.role, n]));
  const nodes: AnalystTeamGraphNode[] = [...nodeRoles]
    .filter((r) => r !== "unknown")
    .sort()
    .map((role) => {
      const existing = nodeByRole.get(role);
      return (
        existing ?? {
          id: role,
          role,
          label: role,
        }
      );
    });

  const toolCountByRole = new Map<string, number>();
  for (const t of teamGraph.toolCalls ?? []) {
    if (!allow.has(t.agentRole)) continue;
    toolCountByRole.set(t.agentRole, (toolCountByRole.get(t.agentRole) ?? 0) + 1);
  }

  const edgesFromLog = aggregateEdgesFromInteractions(interactions, toolCountByRole);

  const edgeByKey = new Map<string, AnalystTeamGraphEdge>();
  for (const e of teamGraph.edges ?? []) {
    if (!nodeRoles.has(e.a) || !nodeRoles.has(e.b)) continue;
    if (e.messageCount === 0 && e.toolCount === 0) {
      edgeByKey.set(e.key, e);
    }
  }
  for (const e of edgesFromLog) {
    const prev = edgeByKey.get(e.key);
    if (prev) {
      edgeByKey.set(e.key, {
        ...prev,
        messageCount: Math.max(prev.messageCount, e.messageCount),
        toolCount: Math.max(prev.toolCount, e.toolCount),
      });
    } else {
      edgeByKey.set(e.key, e);
    }
  }

  const edges = [...edgeByKey.values()];

  return {
    ...teamGraph,
    nodes,
    edges,
    interactions,
    toolCalls: (teamGraph.toolCalls ?? []).filter((t) => allow.has(t.agentRole)),
    mcpCalls: (teamGraph.mcpCalls ?? []).filter((m) => allow.has(m.agentRole)),
    agentSteps: (teamGraph.agentSteps ?? []).filter((s) => allow.has(s.agentRole)),
  };
}

export function filterInteractionsForEdge(
  interactions: AnalystTeamGraphInteraction[],
  a: string,
  b: string
): AnalystTeamGraphInteraction[] {
  return interactions.filter(
    (row) => row.kind !== "tool_call" && matchesEdge(a, b, row.fromRole, row.toRole)
  );
}
