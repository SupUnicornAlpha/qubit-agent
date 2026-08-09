import { describe, expect, test } from "bun:test";
import {
  buildTopologySpecialistExecutionContract,
  classifyMarketDataRequestMode,
  isRedundantTopologyProbe,
  isTopologyTeamTool,
  mergeOrchestratorToolsJson,
  parseRoleFromTopologyTeamTool,
  resolveDispatchRole,
  resolveTopologyTaskTimeoutMs,
  resolveTopologyToolTimeoutMs,
  shouldForceTopologySpecialistSynthesis,
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
    expect(merged).toContain("agent.invoke");
    expect(merged).not.toContain("assign_task");
    expect(merged).toContain("evaluate_risk");
    expect(merged).toContain("run_screener");
    expect(merged).toContain("recommendation.record");
    expect(merged).toContain("factor.register");
    expect(merged).toContain("market.snapshot.get");
    expect(merged).toContain("research.thesis.write");
    expect(merged).toContain("portfolio.construct");
    expect(merged).toContain("strategy.create_version");
    expect(merged).toContain("order.create_intent");
    expect(merged).toContain("call_team_research");
    expect(merged).toContain("call_team_backtest");
    expect(merged).not.toContain("run_analyst_team");
    expect(merged).not.toContain("fuse_signals");
    expect(merged).not.toContain("edit_agent_pack");
    expect(merged).not.toContain("market.readiness");
    expect(merged).not.toContain("factor.list");
  });

  test("team tool timeout always outlives its inner gather budget", () => {
    expect(resolveTopologyTaskTimeoutMs("market_data", undefined)).toBe(900_000);
    expect(resolveTopologyTaskTimeoutMs("research", undefined)).toBe(900_000);
    expect(resolveTopologyToolTimeoutMs("call_team_market_data")).toBe(910_000);
    expect(resolveTopologyToolTimeoutMs("call_team_research")).toBe(910_000);
    expect(resolveTopologyToolTimeoutMs("fetch_klines")).toBeUndefined();
  });

  test("configured topology timeout is bounded", () => {
    expect(resolveTopologyTaskTimeoutMs("research", "5000")).toBe(10_000);
    expect(resolveTopologyTaskTimeoutMs("research", "99999999")).toBe(3_600_000);
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
    const marketContract = buildTopologySpecialistExecutionContract(
      "market_data",
      "获取 603986 今天实时行情"
    );
    expect(marketContract).toContain("调度超时");
    expect(marketContract).toContain("禁止再次调用 readiness");
    expect(marketContract).toContain("fetch_quote");
    expect(marketContract).toContain("禁止用日 K 成功冒充实时行情");
    const researchContract = buildTopologySpecialistExecutionContract("research");
    expect(researchContract).toContain("单标的研究不得用 factor.autoEvaluate");
  });

  test("classifies live-price requests without treating ordinary history as realtime", () => {
    expect(classifyMarketDataRequestMode("获取兆易创新今天实时行情")).toBe("realtime");
    expect(classifyMarketDataRequestMode("What is the current price of AAPL?")).toBe("realtime");
    expect(classifyMarketDataRequestMode("获取兆易创新最近 30 个交易日 K 线")).toBe("historical");
  });

  test("reserves a synthesis turn for a delegated specialist", () => {
    const toolCalls = Array.from({ length: 10 }, () => ({
      toolName: "fetch_klines",
      status: "success",
    }));
    expect(
      shouldForceTopologySpecialistSynthesis({
        taskType: "topology_dispatch",
        role: "analyst_technical",
        toolCalls,
      })
    ).toBe(true);
    expect(
      shouldForceTopologySpecialistSynthesis({
        taskType: "orchestrator_chat",
        role: "orchestrator",
        toolCalls,
      })
    ).toBe(false);
  });
});
