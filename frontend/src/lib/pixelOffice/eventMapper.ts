import type { PixelOfficeGraphInput, OfficeEvent } from "./types";
import { classifyInteractionKind, classifyToolAction, isToolSuccess } from "./classify";
import { isEmptyToolResponse } from "./emptyResponse";

function ts(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : 0;
}

function outcomeKind(
  ok: boolean,
  responseJson: unknown
): "success" | "fail" | "success_empty" {
  if (!ok) return "fail";
  if (isEmptyToolResponse(responseJson)) return "success_empty";
  return "success";
}

/** 将 team-graph 增量事件转为办公室动画事件（按时间排序） */
export function mapGraphToOfficeEvents(
  graph: PixelOfficeGraphInput,
  seenIds: ReadonlySet<string>
): OfficeEvent[] {
  const out: OfficeEvent[] = [];

  for (const row of graph.interactions) {
    if (seenIds.has(`i:${row.id}`)) continue;
    const kind = classifyInteractionKind(row.kind);
    if (kind === "chat") {
      if (row.fromRole && row.toRole && row.fromRole !== row.toRole) {
        out.push({
          id: `i:${row.id}:send`,
          at: ts(row.createdAt),
          kind: "chat_send",
          role: row.fromRole,
          peerRole: row.toRole,
          label: row.toolName ? `${row.toolName}` : undefined,
        });
        out.push({
          id: `i:${row.id}:recv`,
          at: ts(row.createdAt),
          kind: "chat_recv",
          role: row.toRole,
          peerRole: row.fromRole,
        });
      }
      continue;
    }
    if (kind === "signal") {
      out.push({
        id: `i:${row.id}`,
        at: ts(row.createdAt),
        kind: "signal",
        role: row.fromRole,
        label: "信号",
      });
      continue;
    }
    if (kind === "tool") {
      out.push({
        id: `i:${row.id}`,
        at: ts(row.createdAt),
        kind: "go_rack",
        role: row.fromRole,
        label: row.toolName ?? "tool",
      });
    }
  }

  for (const tc of graph.toolCalls) {
    if (seenIds.has(`t:${tc.id}`)) continue;
    const work = classifyToolAction(tc);
    const goKind = work === "skill" ? "go_shelf" : "go_rack";
    out.push({
      id: `t:${tc.id}:go`,
      at: ts(tc.createdAt),
      kind: goKind,
      role: tc.agentRole,
      label: tc.toolName,
    });
    out.push({
      id: `t:${tc.id}:work`,
      at: ts(tc.createdAt) + 400,
      kind: work === "skill" ? "at_shelf" : "at_rack",
      role: tc.agentRole,
      label: tc.toolName,
    });
    const fx = outcomeKind(isToolSuccess(tc.status), tc.responseJson);
    out.push({
      id: `t:${tc.id}:fx`,
      at: ts(tc.createdAt) + 1200,
      kind: fx,
      role: tc.agentRole,
      empty: fx === "success_empty",
    });
  }

  for (const mc of graph.mcpCalls) {
    if (seenIds.has(`m:${mc.id}`)) continue;
    out.push({
      id: `m:${mc.id}:go`,
      at: ts(mc.createdAt),
      kind: "go_rack",
      role: mc.agentRole,
      label: `${mc.serverName}/${mc.toolName}`,
    });
    out.push({
      id: `m:${mc.id}:work`,
      at: ts(mc.createdAt) + 400,
      kind: "at_rack",
      role: mc.agentRole,
      label: mc.toolName,
    });
    const fx = outcomeKind(isToolSuccess(mc.status), mc.responseJson);
    out.push({
      id: `m:${mc.id}:fx`,
      at: ts(mc.createdAt) + 1200,
      kind: fx,
      role: mc.agentRole,
      empty: fx === "success_empty",
    });
  }

  out.sort((a, b) => a.at - b.at);
  return out;
}

/** 内置映射 + 已注册插件 hooks */
export function mapGraphToOfficeEventsExtended(
  graph: PixelOfficeGraphInput,
  seenIds: ReadonlySet<string>,
  hooks: ReadonlyArray<
    (graph: PixelOfficeGraphInput, seen: ReadonlySet<string>, emit: (e: OfficeEvent[]) => void) => void
  >
): OfficeEvent[] {
  const base = mapGraphToOfficeEvents(graph, seenIds);
  const extra: OfficeEvent[] = [];
  for (const hook of hooks) {
    hook(graph, seenIds, (evs) => extra.push(...evs));
  }
  return [...base, ...extra].sort((a, b) => a.at - b.at);
}
