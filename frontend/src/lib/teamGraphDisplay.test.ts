/**
 * 拓扑画布：fan-out 广播展开 + 活动作用域节点（默认仅 user/orchestrator）。
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
    expect(edges.length).toBe(3);
    const keys = new Set(edges.map((e) => e.key));
    expect(keys.has("analyst_fundamental||orchestrator")).toBe(true);
    expect(keys.has("analyst_technical||orchestrator")).toBe(true);
    expect(keys.has("analyst_macro||orchestrator")).toBe(true);
    expect([...keys].some((k) => k.includes("__team__"))).toBe(false);
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
    expect(edge.length).toBe(2);

    const macroEdge = filterInteractionsForEdge(rows, "orchestrator", "analyst_macro");
    expect(macroEdge.length).toBe(1);
    expect(macroEdge[0]?.toRole).toBe("__team__");

    const otherEdge = filterInteractionsForEdge(rows, "orchestrator", "analyst_technical");
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
    const filtered = buildFilteredTeamGraphDisplay(teamGraph);
    const nodeIds = filtered.nodes.map((n) => n.role);
    expect(nodeIds.includes("__team__")).toBe(false);
    expect(nodeIds.includes("analyst_technical")).toBe(true);
    expect(nodeIds.includes("orchestrator")).toBe(true);
    for (const e of filtered.edges) {
      expect(e.a).not.toBe("__team__");
      expect(e.b).not.toBe("__team__");
    }
  });
});

describe("teamGraphDisplay activity-scoped nodes", () => {
  test("空闲时只展示 user + orchestrator，不铺未调用槽位", () => {
    const teamGraph: AnalystTeamGraphPayload = {
      nodes: [
        { id: "user", role: "user", label: "用户" },
        { id: "orchestrator", role: "orchestrator", label: "编排器" },
        { id: "risk", role: "risk", label: "risk" },
        { id: "research", role: "research", label: "research" },
        { id: "backtest", role: "backtest", label: "backtest" },
        { id: "analyst_fundamental", role: "analyst_fundamental", label: "fundamental" },
        { id: "custom_alpha", role: "custom_alpha", label: "custom" },
      ],
      edges: [
        {
          key: "orchestrator||research",
          a: "orchestrator",
          b: "research",
          messageCount: 0,
          toolCount: 0,
        },
      ],
      interactions: [
        mkInteraction({
          fromRole: "user",
          toRole: "orchestrator",
          contentText: "帮我看看 NVDA",
        }),
      ],
      toolCalls: [],
      mcpCalls: [],
    };

    const filtered = buildFilteredTeamGraphDisplay(teamGraph, [
      "risk",
      "research",
      "backtest",
      "analyst_fundamental",
    ]);
    const roles = new Set(filtered.nodes.map((n) => n.role));
    expect([...roles].sort()).toEqual(["orchestrator", "user"]);
    expect(filtered.edges.length).toBe(1);
    expect(filtered.edges[0]?.a === "orchestrator" || filtered.edges[0]?.b === "orchestrator").toBe(
      true
    );
  });

  test("任意被调用的新角色都会入图（不钉死角色类型）", () => {
    const teamGraph: AnalystTeamGraphPayload = {
      nodes: [
        { id: "user", role: "user", label: "用户" },
        { id: "orchestrator", role: "orchestrator", label: "编排器" },
        { id: "factor_scout", role: "factor_scout", label: "Factor Scout" },
      ],
      edges: [],
      interactions: [
        mkInteraction({
          fromRole: "user",
          toRole: "orchestrator",
          contentText: "发现新因子",
        }),
        mkInteraction({
          fromRole: "orchestrator",
          toRole: "factor_scout",
          contentText: "请筛选候选因子",
        }),
      ],
      toolCalls: [],
      mcpCalls: [],
    };

    const filtered = buildFilteredTeamGraphDisplay(teamGraph);
    const roles = new Set(filtered.nodes.map((n) => n.role));
    expect(roles.has("user")).toBe(true);
    expect(roles.has("orchestrator")).toBe(true);
    expect(roles.has("factor_scout")).toBe(true);
    expect(roles.size).toBe(3);
  });

  test("有通信时 msa 才入图；未使用时不常驻", () => {
    const base: AnalystTeamGraphPayload = {
      nodes: [
        { id: "orchestrator", role: "orchestrator", label: "Orchestrator" },
        { id: "msa", role: "msa", label: "MSA" },
      ],
      edges: [],
      interactions: [
        mkInteraction({
          fromRole: "orchestrator",
          toRole: "user",
          contentText: "直接答复",
        }),
      ],
      toolCalls: [],
      mcpCalls: [],
    };
    const idle = buildFilteredTeamGraphDisplay(base);
    expect(idle.nodes.map((n) => n.role).includes("msa")).toBe(false);

    const used = buildFilteredTeamGraphDisplay({
      ...base,
      interactions: [
        ...base.interactions,
        mkInteraction({
          fromRole: "orchestrator",
          toRole: "msa",
          contentText: "启动融合",
        }),
      ],
    });
    expect(used.nodes.map((n) => n.role).includes("msa")).toBe(true);
  });
});
