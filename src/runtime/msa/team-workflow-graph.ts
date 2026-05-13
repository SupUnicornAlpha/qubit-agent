import { eq, inArray, asc } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentStep,
  analystSignal,
  debateSession,
  debateTurn,
  mcpCallLog,
  researchTeamInteraction,
  toolCallLog,
} from "../../db/sqlite/schema";

export interface TeamGraphNode {
  id: string;
  role: string;
  label: string;
}

export interface TeamGraphEdge {
  key: string;
  a: string;
  b: string;
  messageCount: number;
  toolCount: number;
}

export interface TeamGraphToolCall {
  id: string;
  agentRole: string;
  agentInstanceId: string;
  toolName: string;
  toolKind: string;
  status: string;
  latencyMs: number | null;
  createdAt: string;
  agentStepId: string;
}

export interface TeamGraphMcpCall {
  id: string;
  agentRole: string;
  agentInstanceId: string;
  serverName: string;
  toolName: string;
  status: string;
  latencyMs: number | null;
  createdAt: string;
}

export interface TeamGraphInteractionRow {
  id: string;
  workflowRunId: string;
  fromRole: string;
  toRole: string;
  kind: string;
  toolKind: string | null;
  toolName: string | null;
  contentText: string;
  payloadJson: unknown;
  createdAt: string;
}

function undirectedKey(a: string, b: string): string {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

function roleLabel(role: string): string {
  const map: Record<string, string> = {
    msa: "MSA 融合",
    signal_fusion: "MSA 融合",
    analyst_fundamental: "基本面",
    analyst_technical: "技术面",
    analyst_sentiment: "情绪面",
    analyst_macro: "宏观",
    researcher_bull: "多方辩论",
    researcher_bear: "空方辩论",
    orchestrator: "编排器",
    risk: "风控",
    risk_manager: "风控",
    __tools__: "Tool / MCP",
  };
  return map[role] ?? role;
}

/**
 * 构建某 workflow 下的 Agent 对话拓扑：节点=角色，边=无向对话（次数来自轨迹表 + 历史信号/辩论回退）。
 */
export async function buildTeamWorkflowGraph(workflowRunId: string): Promise<{
  nodes: TeamGraphNode[];
  edges: TeamGraphEdge[];
  interactions: TeamGraphInteractionRow[];
  toolCalls: TeamGraphToolCall[];
  mcpCalls: TeamGraphMcpCall[];
}> {
  const db = await getDb();

  const [logged, signals, sessions, instances, steps, mcpRows] = await Promise.all([
    db
      .select()
      .from(researchTeamInteraction)
      .where(eq(researchTeamInteraction.workflowRunId, workflowRunId))
      .orderBy(asc(researchTeamInteraction.createdAt)),
    db.select().from(analystSignal).where(eq(analystSignal.workflowRunId, workflowRunId)),
    db.select().from(debateSession).where(eq(debateSession.workflowRunId, workflowRunId)),
    db.select().from(agentInstance).where(eq(agentInstance.workflowRunId, workflowRunId)),
    db.select().from(agentStep).where(eq(agentStep.workflowRunId, workflowRunId)),
    db.select().from(mcpCallLog).where(eq(mcpCallLog.workflowRunId, workflowRunId)),
  ]);

  const definitions = await db.select().from(agentDefinition);
  const defRole = new Map(definitions.map((d) => [d.id, d.role]));

  const instanceRole = new Map<string, string>();
  for (const inst of instances) {
    instanceRole.set(inst.id, defRole.get(inst.definitionId) ?? "unknown");
  }

  const stepIds = steps.map((s) => s.id);
  const allTools =
    stepIds.length > 0
      ? await db.select().from(toolCallLog).where(inArray(toolCallLog.agentStepId, stepIds))
      : [];

  const stepById = new Map(steps.map((s) => [s.id, s]));
  const toolCalls: TeamGraphToolCall[] = allTools.map((t) => {
    const st = stepById.get(t.agentStepId);
    const ar = st ? (instanceRole.get(st.agentInstanceId) ?? "unknown") : "unknown";
    return {
      id: t.id,
      agentRole: ar,
      agentInstanceId: st?.agentInstanceId ?? "",
      toolName: t.toolName,
      toolKind: t.toolKind,
      status: t.status,
      latencyMs: t.latencyMs,
      createdAt: t.createdAt,
      agentStepId: t.agentStepId,
    };
  });

  const mcpCalls: TeamGraphMcpCall[] = mcpRows.map((m) => {
    const st = stepById.get(m.agentStepId);
    const ar = st ? (instanceRole.get(st.agentInstanceId) ?? "unknown") : "unknown";
    return {
      id: m.id,
      agentRole: ar,
      agentInstanceId: st?.agentInstanceId ?? "",
      serverName: m.serverName,
      toolName: m.toolName,
      status: m.status,
      latencyMs: m.latencyMs,
      createdAt: m.createdAt,
    };
  });

  type EdgeAgg = { messageCount: number; toolCount: number };
  const edgeMap = new Map<string, EdgeAgg>();

  const bumpEdge = (x: string, y: string, messages: number, tools: number) => {
    if (!x || !y || x === y) return;
    const k = undirectedKey(x, y);
    const cur = edgeMap.get(k) ?? { messageCount: 0, toolCount: 0 };
    cur.messageCount += messages;
    cur.toolCount += tools;
    edgeMap.set(k, cur);
  };

  const rows: TeamGraphInteractionRow[] = logged.map((r) => ({
    id: r.id,
    workflowRunId: r.workflowRunId,
    fromRole: r.fromRole,
    toRole: r.toRole,
    kind: r.kind,
    toolKind: r.toolKind,
    toolName: r.toolName,
    contentText: r.contentText,
    payloadJson: r.payloadJson,
    createdAt: r.createdAt,
  }));

  for (const r of rows) {
    if (r.kind === "tool_call") continue;
    bumpEdge(r.fromRole, r.toRole, 1, 0);
  }

  /** 历史数据：无 interaction 表记录时，从 analyst_signal / debate 推断边 */
  if (rows.length === 0) {
    for (const s of signals) {
      bumpEdge(String(s.analystRole), "msa", 1, 0);
    }
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length > 0) {
      const turns = await db
        .select()
        .from(debateTurn)
        .where(inArray(debateTurn.debateSessionId, sessionIds))
        .orderBy(asc(debateTurn.roundNumber));
      const peer: Record<string, string> = {
        researcher_bull: "researcher_bear",
        researcher_bear: "researcher_bull",
      };
      for (const t of turns) {
        const other = peer[t.speakerRole] ?? "debate_panel";
        bumpEdge(t.speakerRole, other, 1, 0);
      }
    }
  }

  for (const t of toolCalls) {
    bumpEdge(t.agentRole, "__tools__", 0, 1);
  }
  for (const m of mcpCalls) {
    bumpEdge(m.agentRole, "__tools__", 0, 1);
  }

  const nodeRoles = new Set<string>();
  for (const k of edgeMap.keys()) {
    const [x, y] = k.split("||");
    nodeRoles.add(x);
    nodeRoles.add(y);
  }
  for (const r of rows) {
    nodeRoles.add(r.fromRole);
    nodeRoles.add(r.toRole);
  }
  for (const t of toolCalls) nodeRoles.add(t.agentRole);
  for (const m of mcpCalls) nodeRoles.add(m.agentRole);
  nodeRoles.add("msa");

  const nodes: TeamGraphNode[] = [...nodeRoles]
    .filter((r) => r !== "unknown")
    .sort()
    .map((role) => ({
      id: role,
      role,
      label: roleLabel(role),
    }));

  const edges: TeamGraphEdge[] = [...edgeMap.entries()].map(([key, agg]) => {
    const [a, b] = key.split("||");
    return { key, a, b, messageCount: agg.messageCount, toolCount: agg.toolCount };
  });

  return { nodes, edges, interactions: rows, toolCalls, mcpCalls };
}
