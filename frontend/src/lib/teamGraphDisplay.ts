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

type EdgeAgg = {
  messageCount: number;
  toolCount: number;
  messagesAtoB: number;
  messagesBtoA: number;
  toolSuccessCount: number;
  toolFailCount: number;
};

function emptyAgg(): EdgeAgg {
  return {
    messageCount: 0,
    toolCount: 0,
    messagesAtoB: 0,
    messagesBtoA: 0,
    toolSuccessCount: 0,
    toolFailCount: 0,
  };
}

function toEdge(key: string, agg: EdgeAgg): AnalystTeamGraphEdge {
  const [a, b] = key.split("||");
  return {
    key,
    a,
    b,
    messageCount: agg.messageCount,
    toolCount: agg.toolCount,
    messagesAtoB: agg.messagesAtoB,
    messagesBtoA: agg.messagesBtoA,
    toolSuccessCount: agg.toolSuccessCount,
    toolFailCount: agg.toolFailCount,
  };
}

/** 从交互记录聚合无向边（含有向计数） */
export function aggregateEdgesFromInteractions(
  interactions: AnalystTeamGraphInteraction[],
  toolCallsByRole?: Map<string, { total: number; success: number; fail: number }>
): AnalystTeamGraphEdge[] {
  const map = new Map<string, EdgeAgg>();

  const bumpMessage = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    const a = from < to ? from : to;
    const b = from < to ? to : from;
    const key = teamGraphUndirectedKey(a, b);
    const cur = map.get(key) ?? emptyAgg();
    cur.messageCount += 1;
    if (from === a) cur.messagesAtoB += 1;
    else cur.messagesBtoA += 1;
    map.set(key, cur);
  };

  for (const row of interactions) {
    if (row.kind === "tool_call") continue;
    bumpMessage(row.fromRole, row.toRole);
  }

  if (toolCallsByRole) {
    for (const [role, stats] of toolCallsByRole) {
      if (stats.total <= 0) continue;
      const key = teamGraphUndirectedKey(role, "__tools__");
      const cur = map.get(key) ?? emptyAgg();
      cur.toolCount += stats.total;
      cur.toolSuccessCount += stats.success;
      cur.toolFailCount += stats.fail;
      map.set(key, cur);
    }
  }

  return [...map.entries()].map(([key, agg]) => toEdge(key, agg));
}

/**
 * 按左侧勾选的分析师过滤展示图，但保留与外部角色（如 msa）的实际通信边。
 */
const ALWAYS_VISIBLE_GRAPH_ROLES = new Set(["orchestrator", "msa", "signal_fusion"]);

function mergeEdge(prev: AnalystTeamGraphEdge, next: AnalystTeamGraphEdge): AnalystTeamGraphEdge {
  return {
    ...prev,
    messageCount: Math.max(prev.messageCount, next.messageCount),
    toolCount: Math.max(prev.toolCount, next.toolCount),
    messagesAtoB: Math.max(prev.messagesAtoB ?? 0, next.messagesAtoB ?? 0),
    messagesBtoA: Math.max(prev.messagesBtoA ?? 0, next.messagesBtoA ?? 0),
    toolSuccessCount: Math.max(prev.toolSuccessCount ?? 0, next.toolSuccessCount ?? 0),
    toolFailCount: Math.max(prev.toolFailCount ?? 0, next.toolFailCount ?? 0),
  };
}

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

  const toolStatsByRole = new Map<string, { total: number; success: number; fail: number }>();
  const toolOk = (status: string) => status === "success";
  for (const t of teamGraph.toolCalls ?? []) {
    if (!allow.has(t.agentRole)) continue;
    const cur = toolStatsByRole.get(t.agentRole) ?? { total: 0, success: 0, fail: 0 };
    cur.total += 1;
    if (toolOk(t.status)) cur.success += 1;
    else cur.fail += 1;
    toolStatsByRole.set(t.agentRole, cur);
  }
  for (const m of teamGraph.mcpCalls ?? []) {
    if (!allow.has(m.agentRole)) continue;
    const cur = toolStatsByRole.get(m.agentRole) ?? { total: 0, success: 0, fail: 0 };
    cur.total += 1;
    if (toolOk(m.status)) cur.success += 1;
    else cur.fail += 1;
    toolStatsByRole.set(m.agentRole, cur);
  }

  const edgesFromLog = aggregateEdgesFromInteractions(interactions, toolStatsByRole);

  const edgeByKey = new Map<string, AnalystTeamGraphEdge>();
  for (const e of teamGraph.edges ?? []) {
    if (!nodeRoles.has(e.a) || !nodeRoles.has(e.b)) continue;
    if (e.messageCount === 0 && e.toolCount === 0) {
      edgeByKey.set(e.key, e);
    }
  }
  for (const e of edgesFromLog) {
    const prev = edgeByKey.get(e.key);
    edgeByKey.set(e.key, prev ? mergeEdge(prev, e) : e);
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
