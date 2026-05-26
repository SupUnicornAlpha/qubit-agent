import { describe, expect, test } from "bun:test";
import {
  isTopologyTeamTool,
  mergeOrchestratorToolsJson,
  parseOrchestratorOutboundEdges,
  parseRoleFromTopologyTeamTool,
  resolveDispatchRole,
  topologyTeamToolName,
} from "./topology-dispatch";

describe("topology-dispatch", () => {
  test("topology team tool names", () => {
    expect(topologyTeamToolName("research")).toBe("call_team_research");
    expect(isTopologyTeamTool("call_team_research")).toBe(true);
    expect(parseRoleFromTopologyTeamTool("call_team_research")).toBe("research");
    expect(parseRoleFromTopologyTeamTool("assign_task")).toBe(null);
  });

  test("parse orchestrator outbound edges", () => {
    const relations = [
      { from: "orchestrator", to: "market_data", edgeKind: "unicast" },
      { from: "market_data", to: "orchestrator", edgeKind: "unicast" },
      { from: "orchestrator", to: "research", edgeKind: "unicast" },
    ];
    const edges = parseOrchestratorOutboundEdges(relations, [
      "orchestrator",
      "market_data",
      "research",
    ]);
    expect(edges.map((e) => e.to)).toEqual(["market_data", "research"]);
  });

  test("resolve dispatch role aliases", () => {
    expect(resolveDispatchRole("risk_manager")).toBe("risk");
    expect(resolveDispatchRole("research")).toBe("research");
  });

  test("merge orchestrator tools", () => {
    const merged = mergeOrchestratorToolsJson(["call_team_research", "call_team_backtest"]);
    expect(merged).toContain("assign_task");
    expect(merged).toContain("run_analyst_team");
    expect(merged).toContain("evaluate_risk");
    expect(merged).toContain("call_team_research");
    expect(merged).toContain("call_team_backtest");
  });
});
