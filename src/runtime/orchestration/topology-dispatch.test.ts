import { describe, expect, test } from "bun:test";
import {
  buildTopologySpecialistExecutionContract,
  isRedundantTopologyProbe,
  isTopologyTeamTool,
  mergeOrchestratorToolsJson,
  parseRoleFromTopologyTeamTool,
  resolveDispatchRole,
  resolveTopologyTaskTimeoutMs,
  resolveTopologyToolTimeoutMs,
  topologyTeamToolName,
} from "./topology-dispatch";

describe("topology-dispatch", () => {
  test("topology team tool names", () => {
    expect(topologyTeamToolName("research")).toBe("call_team_research");
    expect(isTopologyTeamTool("call_team_research")).toBe(true);
    expect(parseRoleFromTopologyTeamTool("call_team_research")).toBe("research");
    expect(parseRoleFromTopologyTeamTool("assign_task")).toBe(null);
  });

  test("resolve dispatch role aliases", () => {
    expect(resolveDispatchRole("risk_manager")).toBe("risk");
    expect(resolveDispatchRole("research")).toBe("research");
  });

  test("merge orchestrator tools", () => {
    const merged = mergeOrchestratorToolsJson(["call_team_research", "call_team_backtest"]);
    expect(merged).toContain("assign_task");
    expect(merged).toContain("evaluate_risk");
    expect(merged).toContain("call_team_research");
    expect(merged).toContain("call_team_backtest");
  });

  test("team tool timeout always outlives its inner gather budget", () => {
    expect(resolveTopologyTaskTimeoutMs("market_data", undefined)).toBe(90_000);
    expect(resolveTopologyTaskTimeoutMs("research", undefined)).toBe(180_000);
    expect(resolveTopologyToolTimeoutMs("call_team_market_data")).toBe(100_000);
    expect(resolveTopologyToolTimeoutMs("call_team_research")).toBe(190_000);
    expect(resolveTopologyToolTimeoutMs("fetch_klines")).toBeUndefined();
  });

  test("configured topology timeout is bounded", () => {
    expect(resolveTopologyTaskTimeoutMs("research", "5000")).toBe(10_000);
    expect(resolveTopologyTaskTimeoutMs("research", "999999")).toBe(300_000);
  });

  test("blocks repeated readiness probes only for topology child tasks", () => {
    const priorToolCalls = [
      { toolName: "market.readiness", status: "success" },
      { toolName: "fetch_klines", status: "success" },
    ];
    expect(
      isRedundantTopologyProbe({
        taskType: "topology_dispatch",
        targetName: "market.readiness",
        priorToolCalls,
      })
    ).toBe(true);
    expect(
      isRedundantTopologyProbe({
        taskType: "manual",
        targetName: "market.readiness",
        priorToolCalls,
      })
    ).toBe(false);
    expect(
      isRedundantTopologyProbe({
        taskType: "topology_dispatch",
        targetName: "fetch_klines",
        priorToolCalls,
      })
    ).toBe(false);
  });

  test("specialist contract distinguishes dispatch timeout from data failure", () => {
    const marketContract = buildTopologySpecialistExecutionContract("market_data");
    expect(marketContract).toContain("调度超时");
    expect(marketContract).toContain("禁止再次调用 readiness");
    const researchContract = buildTopologySpecialistExecutionContract("research");
    expect(researchContract).toContain("单标的研究不得用 factor.autoEvaluate");
  });
});
