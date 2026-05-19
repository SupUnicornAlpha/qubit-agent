import type { AnalystTeamGraphEdge } from "../api/types";

export function isToolGraphEdge(ed: AnalystTeamGraphEdge): boolean {
  return ed.a === "__tools__" || ed.b === "__tools__";
}

export function toolAgentOnEdge(ed: AnalystTeamGraphEdge): string {
  return ed.a === "__tools__" ? ed.b : ed.a;
}

export function edgeMessagesAtoB(ed: AnalystTeamGraphEdge): number {
  return ed.messagesAtoB ?? 0;
}

export function edgeMessagesBtoA(ed: AnalystTeamGraphEdge): number {
  return ed.messagesBtoA ?? 0;
}

export function edgeToolSuccess(ed: AnalystTeamGraphEdge): number {
  return ed.toolSuccessCount ?? 0;
}

export function edgeToolFail(ed: AnalystTeamGraphEdge): number {
  return ed.toolFailCount ?? 0;
}

/** 工具/MCP 边描边色 */
export function toolEdgeStroke(ed: AnalystTeamGraphEdge): string {
  const ok = edgeToolSuccess(ed);
  const fail = edgeToolFail(ed);
  if (fail > 0 && ok === 0) return "var(--qb-topo-edge-fail, #f87171)";
  if (fail > 0 && ok > 0) return "var(--qb-topo-edge-mixed, #fbbf24)";
  if (ok > 0) return "var(--qb-topo-edge-success, #4ade80)";
  return "var(--qb-topo-edge-stroke, #71717a)";
}

export function formatEdgeLabel(ed: AnalystTeamGraphEdge): string {
  if (isToolGraphEdge(ed)) {
    const ok = edgeToolSuccess(ed);
    const fail = edgeToolFail(ed);
    const parts: string[] = [];
    if (ok > 0) parts.push(`✓${ok}`);
    if (fail > 0) parts.push(`✗${fail}`);
    return parts.length > 0 ? `工具 ${parts.join(" ")}` : ed.toolCount > 0 ? `工具 ${ed.toolCount}` : "工具";
  }
  const ab = edgeMessagesAtoB(ed);
  const ba = edgeMessagesBtoA(ed);
  if (ab > 0 && ba > 0) return `↔ 对话 ${ab + ba} (${ed.a}→${ed.b} ${ab} · ${ed.b}→${ed.a} ${ba})`;
  if (ab > 0) return `${ed.a} → ${ed.b} · ${ab}`;
  if (ba > 0) return `${ed.b} → ${ed.a} · ${ba}`;
  if ((ed.messageCount ?? 0) > 0) return `对话 ${ed.messageCount}`;
  return ed.toolCount > 0 ? `工具 ${ed.toolCount}` : "拓扑";
}

export function formatEdgeSelectionSummary(
  a: string,
  b: string,
  ed: AnalystTeamGraphEdge | null,
  messageRows: number
): string {
  const parts: string[] = [];
  if (ed && isToolGraphEdge(ed)) {
    parts.push(`工具 ✓${edgeToolSuccess(ed)} ✗${edgeToolFail(ed)}`);
  } else if (ed) {
    const ab = edgeMessagesAtoB(ed);
    const ba = edgeMessagesBtoA(ed);
    if (ab > 0 && ba > 0) parts.push(`双向对话 ${ab + ba}（${a}→${b} ${ab} · ${b}→${a} ${ba}）`);
    else if (ab > 0) parts.push(`单向 ${a} → ${b} · ${ab} 条`);
    else if (ba > 0) parts.push(`单向 ${b} → ${a} · ${ba} 条`);
    else parts.push(`对话 ${ed.messageCount ?? messageRows} 条`);
  } else {
    parts.push(`对话 ${messageRows} 条`);
  }
  return parts.join(" · ");
}
