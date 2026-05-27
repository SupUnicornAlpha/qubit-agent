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

/**
 * Orchestrator 的 fan-out 广播伪角色：runtime 用 toRole=__team__ 表示"对所有
 * 当前活跃 analyst 一次性广播"，避免对 N 个角色重复落 N 条几乎一样的 llm_message。
 *
 * 拓扑画布在聚合 edge 时**展开**这个伪角色 —— 把 row.payloadJson.targetRoles 里
 * 的每个真实 role 都当成一条 (from, target) 计数。这样：
 *   - 不会出现一个孤立的 __team__ 节点
 *   - orchestrator 跟每个分析师的 fan-out 边都有正确计数
 *   - 互动列表 / 详情面板对应 edge 仍能筛回这条原始广播 row（matchesEdge 会
 *     看到 to=__team__ ≠ 任意真实 role，因此另外用 fanout 路径处理）
 */
const TEAM_BROADCAST_ROLE = "__team__";

function readTargetRoles(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const arr = (payload as { targetRoles?: unknown }).targetRoles;
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const v of arr) if (typeof v === "string" && v.length > 0) out.push(v);
  return out;
}

/**
 * 互动行是否应该在某个 role 白名单 `allow` 下展示。
 *
 * - 普通 1-1 message：fromRole 或 toRole 任一命中即保留（旧行为）。
 * - fan-out 广播 (toRole=__team__)：fromRole 命中或 payloadJson.targetRoles
 *   有任一交集时保留 —— 否则 orchestrator → 全员 这条会因为"toRole 不在
 *   allow"被错误丢掉，UI 看不到广播。
 *
 * 这个函数在 MainContent.tsx 的多个 useMemo 里复用，集中维护单一逻辑源。
 */
export function interactionMatchesAllow(
  row: AnalystTeamGraphInteraction,
  allow: ReadonlySet<string> | null
): boolean {
  if (!allow) return true;
  if (allow.has(row.fromRole)) return true;
  if (row.toRole === TEAM_BROADCAST_ROLE) {
    const targets = readTargetRoles(row.payloadJson);
    return targets.some((t) => allow.has(t));
  }
  return allow.has(row.toRole);
}

/** 把 fan-out 广播 row 的 contentText 加一个简短的"→ 全员（X 个角色）"前缀，
 *  纯文本流的 mergedLiveFeedRows 列表用得到（结构化 LiveConversationView 走 BroadcastBanner）。
 */
export function describeInteractionRouting(row: AnalystTeamGraphInteraction): string {
  if (row.toRole === TEAM_BROADCAST_ROLE) {
    const targets = readTargetRoles(row.payloadJson);
    if (targets.length > 0) {
      return `${row.fromRole} → 全员（${targets.length}）`;
    }
    return `${row.fromRole} → 全员`;
  }
  return `${row.fromRole} → ${row.toRole}`;
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
    if (row.toRole === TEAM_BROADCAST_ROLE) {
      /** 展开 fan-out：targetRoles 缺失则降级为单条 from→__team__（保留旧行为，
       *  __team__ 当作"匿名团队节点"出现，不至于丢边） */
      const targets = readTargetRoles(row.payloadJson);
      if (targets.length === 0) {
        bumpMessage(row.fromRole, row.toRole);
      } else {
        for (const target of targets) bumpMessage(row.fromRole, target);
      }
      continue;
    }
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
    /** __team__ 是 fan-out 广播的伪 toRole，绝不应被加成图节点 */
    if (i.toRole !== TEAM_BROADCAST_ROLE) nodeRoles.add(i.toRole);
    if (i.toRole === TEAM_BROADCAST_ROLE) {
      for (const t of readTargetRoles(i.payloadJson)) nodeRoles.add(t);
    }
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
  return interactions.filter((row) => {
    if (row.kind === "tool_call") return false;
    /**
     * fan-out 广播：matchesEdge(__team__, target) 永远不命中，但只要 (from, target)
     * 命中，就把这条原始 row 也算入该 edge 的详情列表 —— 这样 orchestrator → 各
     * analyst 的 fan-out 广播能在每个对应 edge 的详情里出现一次。
     */
    if (row.toRole === TEAM_BROADCAST_ROLE) {
      const targets = readTargetRoles(row.payloadJson);
      for (const t of targets) {
        if (matchesEdge(a, b, row.fromRole, t)) return true;
      }
      return false;
    }
    return matchesEdge(a, b, row.fromRole, row.toRole);
  });
}
