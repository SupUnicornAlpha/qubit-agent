/**
 * 拓扑画布对 fan-out 广播 (toRole=__team__) 的展开/兼容回归测试。
 *
 * 关键场景：
 *   - aggregateEdgesFromInteractions 应该把一条 from=orchestrator,
 *     to=__team__, payloadJson.targetRoles=[A, B, C] 的 row 展开成 3 条边
 *     (orchestrator,A) (orchestrator,B) (orchestrator,C)，**不**保留 __team__ 边。
 *   - 没有 targetRoles 时退化为单条 from→__team__ 边，保留旧行为。
 *   - filterInteractionsForEdge 在选中 (orchestrator, A) 时，应该把 fan-out
 *     广播 row 也列出来 —— 这样用户点开 edge 详情能看到这条原始广播。
 *   - buildFilteredTeamGraphDisplay 在 nodeRoles 里不应该包含 __team__；
 *     fan-out 目标里的角色应被列入展示节点。
 */

import { describe, expect, test } from "bun:test";
import type { AnalystTeamGraphInteraction, AnalystTeamGraphPayload } from "../api/types";
import {
  aggregateEdgesFromInteractions,
  buildFilteredTeamGraphDisplay,
  filterInteractionsForEdge,
} from "./teamGraphDisplay";

function mkInteraction(
  partial: Partial<AnalystTeamGraphInteraction> & {
    fromRole: string;
    toRole: string;
  }
): AnalystTeamGraphInteraction {
  return {
    id: `i-${Math.random().toString(36).slice(2, 8)}`,
    workflowRunId: "wf-test",
    fromRole: partial.fromRole,
    toRole: partial.toRole,
    kind: partial.kind ?? "llm_message",
    toolKind: partial.toolKind ?? null,
    toolName: partial.toolName ?? null,
    contentText: partial.contentText ?? "",
    payloadJson: partial.payloadJson ?? null,
    createdAt: partial.createdAt ?? "2026-05-27T00:00:00.000Z",
  };
}

describe("teamGraphDisplay fan-out (__team__) compat", () => {
  test("aggregateEdgesFromInteractions 展开 fan-out 为 N 条边，不保留 __team__ 边", () => {
    const rows: AnalystTeamGraphInteraction[] = [
      mkInteraction({
        fromRole: "orchestrator",
        toRole: "__team__",
        payloadJson: {
          targetRoles: ["analyst_fundamental", "analyst_technical", "analyst_macro"],
        },
      }),
    ];
    const edges = aggregateEdgesFromInteractions(rows);
    /** 应该有 3 条 (orchestrator, analyst_*) 边，没有 (orchestrator, __team__) */
    expect(edges.length).toBe(3);
    const keys = new Set(edges.map((e) => e.key));
    expect(keys.has("analyst_fundamental||orchestrator")).toBe(true);
    expect(keys.has("analyst_technical||orchestrator")).toBe(true);
    expect(keys.has("analyst_macro||orchestrator")).toBe(true);
    expect([...keys].some((k) => k.includes("__team__"))).toBe(false);
    /** 每条边都只命中一次 */
    for (const e of edges) {
      expect(e.messageCount).toBe(1);
    }
  });

  test("没有 targetRoles 时退化为 from→__team__ 单条边（旧行为兜底）", () => {
    const rows: AnalystTeamGraphInteraction[] = [
      mkInteraction({
        fromRole: "orchestrator",
        toRole: "__team__",
        payloadJson: null,
      }),
    ];
    const edges = aggregateEdgesFromInteractions(rows);
    expect(edges.length).toBe(1);
    expect(edges[0]?.key).toBe("__team__||orchestrator");
  });

  test("filterInteractionsForEdge 选中 (orchestrator, A) 时把 fan-out 广播列出来", () => {
    const rows: AnalystTeamGraphInteraction[] = [
      mkInteraction({
        fromRole: "orchestrator",
        toRole: "__team__",
        payloadJson: { targetRoles: ["analyst_fundamental", "analyst_macro"] },
      }),
      mkInteraction({
        fromRole: "analyst_fundamental",
        toRole: "orchestrator",
        contentText: "回执",
      }),
    ];
    const edge = filterInteractionsForEdge(rows, "orchestrator", "analyst_fundamental");
    /** 两条都该命中：fan-out 广播 + analyst→orchestrator 回执 */
    expect(edge.length).toBe(2);

    const macroEdge = filterInteractionsForEdge(rows, "orchestrator", "analyst_macro");
    /** 只有 fan-out 广播 */
    expect(macroEdge.length).toBe(1);
    expect(macroEdge[0]?.toRole).toBe("__team__");

    const otherEdge = filterInteractionsForEdge(rows, "orchestrator", "analyst_technical");
    /** technical 不在 targetRoles 列表 → 不命中 */
    expect(otherEdge.length).toBe(0);
  });

  test("buildFilteredTeamGraphDisplay 不把 __team__ 当成图节点", () => {
    const teamGraph: AnalystTeamGraphPayload = {
      nodes: [
        { id: "orchestrator", role: "orchestrator", label: "Orchestrator" },
        { id: "analyst_fundamental", role: "analyst_fundamental", label: "Fundamental" },
      ],
      edges: [],
      interactions: [
        mkInteraction({
          fromRole: "orchestrator",
          toRole: "__team__",
          payloadJson: {
            targetRoles: ["analyst_fundamental", "analyst_technical"],
          },
        }),
      ],
      toolCalls: [],
      mcpCalls: [],
    };
    const filtered = buildFilteredTeamGraphDisplay(teamGraph, [
      "analyst_fundamental",
      "analyst_technical",
    ]);
    /** 节点列表里不应有 __team__ */
    const nodeIds = filtered.nodes.map((n) => n.role);
    expect(nodeIds.includes("__team__")).toBe(false);
    /** 但 fan-out 目标 analyst_technical 应该被加进去（哪怕原 nodes 里没有） */
    expect(nodeIds.includes("analyst_technical")).toBe(true);
    /** orchestrator 也应在（属于 ALWAYS_VISIBLE_GRAPH_ROLES + 在 interaction.fromRole） */
    expect(nodeIds.includes("orchestrator")).toBe(true);
    /** edges 同理不该有 __team__ */
    for (const e of filtered.edges) {
      expect(e.a).not.toBe("__team__");
      expect(e.b).not.toBe("__team__");
    }
  });
});
