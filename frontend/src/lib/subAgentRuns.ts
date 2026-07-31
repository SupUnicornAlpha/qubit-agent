/**
 * 从 teamGraph + 流式状态推导「Orchestrator 已派发的子 Agent」运行摘要。
 * 用于右栏对话：让用户看见谁在跑、跑到哪，而不必先点中间拓扑节点。
 */
import type {
  AnalystTeamGraphAgentStep,
  AnalystTeamGraphInteraction,
  AnalystTeamGraphMcpCall,
  AnalystTeamGraphPayload,
  AnalystTeamGraphToolCall,
} from "../api/types";

export type SubAgentRunStatus = "queued" | "running" | "done" | "failed";

export type SubAgentRunSummary = {
  role: string;
  status: SubAgentRunStatus;
  /** 派发时间（最早一次 orchestrator→role） */
  dispatchedAt: string | null;
  /** 最近活动时间 */
  updatedAt: string;
  /** 一行活动摘要：流式片段 / 最近工具 / 最近思考 */
  headline: string;
  toolCount: number;
  stepCount: number;
  inbound: AnalystTeamGraphInteraction[];
  outbound: AnalystTeamGraphInteraction[];
  steps: AnalystTeamGraphAgentStep[];
  tools: AnalystTeamGraphToolCall[];
  mcps: AnalystTeamGraphMcpCall[];
  streamingText: string | null;
};

const HIDDEN_ROLES = new Set([
  "orchestrator",
  "user",
  "msa",
  "signal_fusion",
  "__team__",
  "__tools__",
  "__skills__",
]);

function isTrackableRole(role: string): boolean {
  return Boolean(role) && !HIDDEN_ROLES.has(role);
}

function newerTs(a: string | null | undefined, b: string | null | undefined): string {
  if (!a) return b ?? "";
  if (!b) return a;
  return a >= b ? a : b;
}

function latestToolHeadline(tools: AnalystTeamGraphToolCall[]): string | null {
  if (tools.length === 0) return null;
  const t = tools[tools.length - 1]!;
  const name = t.toolName || t.connectorId || "tool";
  if (t.status === "error" || t.errorMessage) return `工具失败 · ${name}`;
  if (t.status === "running" || t.status === "pending" || t.status === "in_progress") {
    return `正在调用 · ${name}`;
  }
  return `已调用 · ${name}`;
}

function latestStepHeadline(steps: AnalystTeamGraphAgentStep[]): string | null {
  if (steps.length === 0) return null;
  const s = steps[steps.length - 1]!;
  const thought = (s.thought ?? "").trim().replace(/\s+/g, " ");
  if (thought) {
    return thought.length > 80 ? `${thought.slice(0, 80)}…` : thought;
  }
  return `${s.phase} · ${s.actionType} · step ${s.stepIndex}`;
}

function latestOutboundHeadline(outbound: AnalystTeamGraphInteraction[]): string | null {
  for (let i = outbound.length - 1; i >= 0; i--) {
    const row = outbound[i]!;
    const text = (row.contentText ?? "").trim().replace(/\s+/g, " ");
    if (!text) continue;
    return text.length > 90 ? `${text.slice(0, 90)}…` : text;
  }
  return null;
}

/**
 * 收集 Orchestrator 实际派过单（或已有执行轨迹）的子 Agent。
 * 不含 msa / 伪节点；按最近活动时间倒序。
 */
export function buildSubAgentRunSummaries(input: {
  graph: AnalystTeamGraphPayload | null | undefined;
  streamingByRole: Record<string, { text: string; ts: string }>;
  workflowRunning: boolean;
  /** role → 心跳摘要（alive / phase） */
  heartbeatsByRole?: Record<string, { alive: boolean; lastPhase?: string | null }> | null;
}): SubAgentRunSummary[] {
  const { graph, streamingByRole, workflowRunning, heartbeatsByRole = null } = input;
  if (!graph) return [];

  const roles = new Set<string>();
  for (const n of graph.nodes) {
    if (isTrackableRole(n.role)) roles.add(n.role);
  }
  for (const row of graph.interactions) {
    if (row.fromRole === "orchestrator" && isTrackableRole(row.toRole)) roles.add(row.toRole);
    if (isTrackableRole(row.fromRole)) roles.add(row.fromRole);
  }
  for (const t of graph.toolCalls) {
    if (isTrackableRole(t.agentRole)) roles.add(t.agentRole);
  }
  for (const m of graph.mcpCalls) {
    if (isTrackableRole(m.agentRole)) roles.add(m.agentRole);
  }
  for (const s of graph.agentSteps ?? []) {
    if (isTrackableRole(s.agentRole)) roles.add(s.agentRole);
  }
  for (const role of Object.keys(streamingByRole)) {
    if (isTrackableRole(role)) roles.add(role);
  }

  const out: SubAgentRunSummary[] = [];
  for (const role of roles) {
    const llmRows = graph.interactions.filter((row) => row.kind === "llm_message");
    const inbound = llmRows.filter((row) => row.toRole === role);
    const outbound = llmRows.filter((row) => row.fromRole === role);
    const fromOrch = graph.interactions.filter(
      (row) => row.fromRole === "orchestrator" && row.toRole === role
    );
    const steps = (graph.agentSteps ?? []).filter((s) => s.agentRole === role);
    const tools = graph.toolCalls.filter((t) => t.agentRole === role);
    const mcps = graph.mcpCalls.filter((m) => m.agentRole === role);
    const stream = streamingByRole[role];
    const streamingText = stream?.text?.trim() ? stream.text.trim() : null;

    // 没有任何派发/轨迹/流式 → 跳过（拓扑上的空槽位不打扰）
    if (
      fromOrch.length === 0 &&
      steps.length === 0 &&
      tools.length === 0 &&
      mcps.length === 0 &&
      outbound.length === 0 &&
      !streamingText
    ) {
      continue;
    }

    let updatedAt = stream?.ts ?? "";
    for (const row of [...inbound, ...outbound, ...fromOrch]) {
      updatedAt = newerTs(updatedAt, row.createdAt);
    }
    for (const s of steps) updatedAt = newerTs(updatedAt, s.createdAt);
    for (const t of tools) updatedAt = newerTs(updatedAt, t.createdAt);
    for (const m of mcps) updatedAt = newerTs(updatedAt, m.createdAt);
    if (!updatedAt) updatedAt = new Date(0).toISOString();

    const dispatchedAt =
      fromOrch.length > 0
        ? fromOrch.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), fromOrch[0]!.createdAt)
        : null;

    const lastTool = tools[tools.length - 1];
    const toolFailed = lastTool?.status === "error" || Boolean(lastTool?.errorMessage);
    const hb = heartbeatsByRole?.[role];
    const heartbeatAlive = hb?.alive === true;
    let status: SubAgentRunStatus;
    if (streamingText || heartbeatAlive) {
      status = "running";
    } else if (
      workflowRunning &&
      (lastTool?.status === "running" ||
        lastTool?.status === "pending" ||
        lastTool?.status === "in_progress" ||
        (fromOrch.length > 0 && outbound.length === 0 && steps.length === 0 && tools.length === 0))
    ) {
      status =
        fromOrch.length > 0 && outbound.length === 0 && steps.length === 0 && tools.length === 0
          ? "queued"
          : "running";
    } else if (toolFailed && outbound.length === 0) {
      status = "failed";
    } else if (outbound.length > 0 || steps.length > 0 || tools.length > 0) {
      status = workflowRunning && fromOrch.length > outbound.length ? "running" : "done";
    } else if (fromOrch.length > 0) {
      status = workflowRunning ? "queued" : "done";
    } else {
      status = "done";
    }

    if (
      workflowRunning &&
      status === "done" &&
      streamingText == null &&
      !heartbeatAlive &&
      (tools.some(
        (t) => t.status === "running" || t.status === "pending" || t.status === "in_progress"
      ) ||
        (fromOrch.length > 0 &&
          outbound.length === 0 &&
          newerTs(updatedAt, "") === updatedAt &&
          Date.now() - new Date(updatedAt).getTime() < 120_000))
    ) {
      status = "running";
    }

    const phaseLabel = hb?.lastPhase ? `正在 ${hb.lastPhase}` : "专家 loop 进行中…";

    const headline =
      (streamingText
        ? streamingText.replace(/\s+/g, " ").slice(0, 90) + (streamingText.length > 90 ? "…" : "")
        : null) ??
      latestToolHeadline(tools) ??
      latestStepHeadline(steps) ??
      latestOutboundHeadline(outbound) ??
      (heartbeatAlive ? phaseLabel : null) ??
      (fromOrch.length > 0 ? "已派发，等待专家开始…" : "已有执行轨迹");

    out.push({
      role,
      status,
      dispatchedAt,
      updatedAt,
      headline,
      toolCount: tools.length + mcps.length,
      stepCount: steps.length,
      inbound,
      outbound,
      steps,
      tools,
      mcps,
      streamingText,
    });
  }

  return out.sort((a, b) => {
    const rank = (s: SubAgentRunStatus) =>
      s === "running" ? 0 : s === "queued" ? 1 : s === "failed" ? 2 : 3;
    const dr = rank(a.status) - rank(b.status);
    if (dr !== 0) return dr;
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  });
}
