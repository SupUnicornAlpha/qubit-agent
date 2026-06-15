import { eq, inArray, asc } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentGroup,
  agentGroupMember,
  agentInstance,
  agentStep,
  analystSignal,
  debateSession,
  debateTurn,
  mcpCallLog,
  researchTeamInteraction,
  skillRecallLog,
  toolCallLog,
  workflowRun,
} from "../../db/sqlite/schema";
import type { AgentRole } from "../../types/entities";
import { parseTeamRelations } from "./analyst-team-topology";

/** 节点大类，供前端按类型上不同图标（user=人形 / agent=电脑 / tool=扳手 / skill=书）。 */
export type TeamGraphNodeType = "user" | "agent" | "tool" | "skill";

export interface TeamGraphNode {
  id: string;
  role: string;
  label: string;
  type: TeamGraphNodeType;
}

/** Tool / MCP / CLI 聚合伪节点。 */
export const TOOLS_PSEUDO_ROLE = "__tools__";
/** Skill 召回聚合伪节点。 */
export const SKILLS_PSEUDO_ROLE = "__skills__";

/** 角色 → 节点大类。user=用户；__tools__=工具类；__skills__=技能；其余皆 agent。 */
export function nodeTypeForRole(role: string): TeamGraphNodeType {
  if (role === "user") return "user";
  if (role === TOOLS_PSEUDO_ROLE) return "tool";
  if (role === SKILLS_PSEUDO_ROLE) return "skill";
  return "agent";
}

export interface TeamGraphEdge {
  key: string;
  /** 字典序较小的端点 */
  a: string;
  /** 字典序较大的端点 */
  b: string;
  messageCount: number;
  toolCount: number;
  /** 有向消息 a → b */
  messagesAtoB: number;
  /** 有向消息 b → a */
  messagesBtoA: number;
  toolSuccessCount: number;
  toolFailCount: number;
  /** agent → __skills__ 边的 skill 召回次数（仅 skill 边非 0）。 */
  skillCount: number;
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
  requestJson: unknown;
  responseJson: unknown;
  errorMessage: string | null;
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
  requestJson: unknown;
  responseJson: unknown;
  errorCode: string | null;
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

/** Agent 执行轨迹（ReAct step），供节点详情展示 stream / 推理 */
export interface TeamGraphAgentStep {
  id: string;
  agentRole: string;
  agentInstanceId: string;
  stepIndex: number;
  phase: string;
  actionType: string;
  thought: string | null;
  actionJson: unknown;
  observationJson: unknown;
  latencyMs: number | null;
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
    research: "策略撰写",
    backtest: "回测",
    backtest_engineer: "策略工程",
    researcher_bull: "多方辩论",
    researcher_bear: "空方辩论",
    orchestrator: "编排器",
    risk: "风控",
    risk_manager: "风控经理",
    __tools__: "Tool / MCP",
    __skills__: "Skills",
    user: "用户",
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
  agentSteps: TeamGraphAgentStep[];
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

  // Skill 召回（reason 节点检索出的候选 skill）：按 role 聚合成 agent → __skills__ 边。
  const skillRows = await db
    .select()
    .from(skillRecallLog)
    .where(eq(skillRecallLog.workflowRunId, workflowRunId));

  const stepById = new Map(steps.map((s) => [s.id, s]));
  const agentSteps: TeamGraphAgentStep[] = steps.map((s) => ({
    id: s.id,
    agentRole: instanceRole.get(s.agentInstanceId) ?? "unknown",
    agentInstanceId: s.agentInstanceId,
    stepIndex: s.stepIndex,
    phase: s.phase,
    actionType: s.actionType,
    thought: s.thought,
    actionJson: s.actionJson,
    observationJson: s.observationJson,
    latencyMs: s.latencyMs,
    createdAt: s.createdAt,
  }));

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
      requestJson: t.requestJson,
      responseJson: t.responseJson,
      errorMessage: t.errorMessage,
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
      requestJson: m.requestJson,
      responseJson: m.responseJson ?? null,
      errorCode: m.errorCode ?? null,
    };
  });

  type EdgeAgg = {
    messageCount: number;
    toolCount: number;
    messagesAtoB: number;
    messagesBtoA: number;
    toolSuccessCount: number;
    toolFailCount: number;
    skillCount: number;
  };
  const edgeMap = new Map<string, EdgeAgg>();

  const emptyAgg = (): EdgeAgg => ({
    messageCount: 0,
    toolCount: 0,
    messagesAtoB: 0,
    messagesBtoA: 0,
    toolSuccessCount: 0,
    toolFailCount: 0,
    skillCount: 0,
  });

  const bumpEdge = (x: string, y: string, messages: number, tools: number) => {
    if (!x || !y || x === y) return;
    const k = undirectedKey(x, y);
    const cur = edgeMap.get(k) ?? emptyAgg();
    cur.messageCount += messages;
    cur.toolCount += tools;
    edgeMap.set(k, cur);
  };

  const bumpDirectedMessage = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    const a = from < to ? from : to;
    const b = from < to ? to : from;
    const k = undirectedKey(a, b);
    const cur = edgeMap.get(k) ?? emptyAgg();
    cur.messageCount += 1;
    if (from === a) cur.messagesAtoB += 1;
    else cur.messagesBtoA += 1;
    edgeMap.set(k, cur);
  };

  const bumpToolEdge = (agentRole: string, success: boolean) => {
    if (!agentRole || agentRole === "__tools__") return;
    const k = undirectedKey(agentRole, "__tools__");
    const cur = edgeMap.get(k) ?? emptyAgg();
    cur.toolCount += 1;
    if (success) cur.toolSuccessCount += 1;
    else cur.toolFailCount += 1;
    edgeMap.set(k, cur);
  };

  const bumpSkillEdge = (agentRole: string) => {
    if (!agentRole || agentRole === SKILLS_PSEUDO_ROLE) return;
    const k = undirectedKey(agentRole, SKILLS_PSEUDO_ROLE);
    const cur = edgeMap.get(k) ?? emptyAgg();
    cur.skillCount += 1;
    edgeMap.set(k, cur);
  };

  /** 编组 relations_json：分析开始前即可显示「计划拓扑」边（计数为 0） */
  const wfRow = await db.select().from(workflowRun).where(eq(workflowRun.id, workflowRunId)).limit(1);
  const agentGroupId = wfRow[0]?.agentGroupId ?? null;
  if (agentGroupId) {
    const grpRows = await db.select().from(agentGroup).where(eq(agentGroup.id, agentGroupId)).limit(1);
    const mems = await db
      .select({ role: agentDefinition.role })
      .from(agentGroupMember)
      .innerJoin(agentDefinition, eq(agentGroupMember.definitionId, agentDefinition.id))
      .where(eq(agentGroupMember.groupId, agentGroupId));
    const uniqRoles = [...new Set(mems.map((m) => String(m.role)))];
    const allow = [...uniqRoles, "msa", "signal_fusion", "orchestrator"] as unknown as readonly AgentRole[];
    const topo = parseTeamRelations(grpRows[0]?.relationsJson ?? [], allow);
    for (const e of topo) bumpEdge(String(e.from), String(e.to), 0, 0);
  }

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
    bumpDirectedMessage(r.fromRole, r.toRole);
  }

  /** 历史数据：无 interaction 表记录时，从 analyst_signal / debate 推断边 */
  if (rows.length === 0) {
    for (const s of signals) {
      bumpDirectedMessage(String(s.analystRole), "msa");
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
        bumpDirectedMessage(t.speakerRole, other);
      }
    }
  }

  const toolOk = (status: string) => status === "success";
  for (const t of toolCalls) {
    bumpToolEdge(t.agentRole, toolOk(t.status));
  }
  for (const m of mcpCalls) {
    bumpToolEdge(m.agentRole, toolOk(m.status));
  }
  for (const sr of skillRows) {
    const role = sr.definitionId ? defRole.get(sr.definitionId) : undefined;
    if (role && role !== "unknown") bumpSkillEdge(role);
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
  nodeRoles.add("orchestrator");

  /** 本工作流实例上的角色（含 orchestrator、各 analyst 槽位等），避免仅有边外角色时漏节点 */
  for (const inst of instances) {
    const role = defRole.get(inst.definitionId);
    if (role && role !== "unknown") nodeRoles.add(role);
  }

  const nodes: TeamGraphNode[] = [...nodeRoles]
    .filter((r) => r !== "unknown")
    .sort()
    .map((role) => ({
      id: role,
      role,
      label: roleLabel(role),
      type: nodeTypeForRole(role),
    }));

  const edges: TeamGraphEdge[] = [...edgeMap.entries()].map(([key, agg]) => {
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
      skillCount: agg.skillCount,
    };
  });

  return { nodes, edges, interactions: rows, toolCalls, mcpCalls, agentSteps };
}
