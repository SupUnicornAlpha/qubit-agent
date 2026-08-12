import { describe, expect, test } from "bun:test";
import {
  applyMissingArtifactToolFilter,
  applyStallToolFilter,
  attachMarketGovernanceTools,
  intersectCapabilityWithEffectiveTools,
} from "./resolve-effective-tools";

describe("attachMarketGovernanceTools", () => {
  test("upgrades historical market-capable agent definitions at runtime", () => {
    const tools = attachMarketGovernanceTools("research", ["fetch_klines", "factor.compute"]);
    expect(tools).toContain("market.resolve_symbol");
    expect(tools).toContain("market.data_sources");
    expect(tools).toContain("market.readiness");
    expect(tools).toContain("market.snapshot.get");
  });

  test("orchestrator only gets Prime market tools (resolve + snapshot)", () => {
    const tools = attachMarketGovernanceTools("orchestrator", ["assign_task", "evaluate_risk"]);
    expect(tools).toContain("market.resolve_symbol");
    expect(tools).toContain("market.snapshot.get");
    expect(tools).not.toContain("market.data_sources");
    expect(tools).not.toContain("market.readiness");
  });

  test("keeps unrelated specialist tool surfaces narrow", () => {
    expect(attachMarketGovernanceTools("risk", ["evaluate_risk"])).toEqual(["evaluate_risk"]);
  });
});

describe("applyStallToolFilter", () => {
  test("after factor.list, only strategy write tools remain", () => {
    const filtered = applyStallToolFilter({
      tools: [
        "factor.list",
        "strategy.create_version",
        "strategy.compose",
        "update_plan",
        "backtest.run",
      ],
      notAttemptedCapabilities: ["strategy"],
      attemptedTools: ["factor.list"],
    });
    expect(filtered).toEqual(["strategy.create_version", "strategy.compose"]);
  });

  test("keeps run_screener until screener capability is satisfied", () => {
    const filtered = applyStallToolFilter({
      tools: ["run_screener", "recommendation.record", "update_plan"],
      notAttemptedCapabilities: ["screener", "recommendation.record"],
      attemptedTools: ["update_plan"],
    });
    expect(filtered).toContain("run_screener");
    expect(filtered).toContain("recommendation.record");
    expect(filtered).not.toContain("update_plan");
  });

  test("after screener, keeps only recommendation.record", () => {
    const filtered = applyStallToolFilter({
      tools: ["run_screener", "recommendation.record", "fetch_klines", "update_plan"],
      notAttemptedCapabilities: ["recommendation.record"],
      attemptedTools: ["run_screener"],
    });
    expect(filtered).toEqual(["recommendation.record"]);
  });

  test("after strategy.create_version, keeps only order tools for live trading", () => {
    const filtered = applyStallToolFilter({
      tools: ["strategy.create_version", "order.create_intent", "evaluate_risk", "submit_order"],
      notAttemptedCapabilities: ["order", "risk"],
      attemptedTools: ["strategy.create_version"],
    });
    expect(filtered).toContain("order.create_intent");
    expect(filtered).not.toContain("strategy.create_version");
    // evaluate_risk still matches risk capability
    expect(filtered).toContain("evaluate_risk");
  });

  test("missing composition narrows to strategy.compose", () => {
    const filtered = applyMissingArtifactToolFilter({
      tools: ["factor.list", "strategy.create_version", "strategy.compose", "backtest.run"],
      missingTables: ["strategy_composition", "quality:strategy_backtest_completed"],
    });
    expect(filtered).toEqual(["strategy.compose", "backtest.run"]);
  });
});

describe("capability / progress tool intersection", () => {
  test("does not re-expose an authorized probe after the scenario surface narrows", () => {
    const tools = intersectCapabilityWithEffectiveTools(
      ["factor.list", "factor.register", "factor.evaluate", "qubit-data/fetch_klines"],
      ["factor.evaluate", "factor.register"]
    );
    expect(tools).toEqual(["factor.register", "factor.evaluate"]);
  });

  test("matches connector-qualified tools to their scenario tool name", () => {
    expect(
      intersectCapabilityWithEffectiveTools(["qubit-data/fetch_klines"], ["fetch_klines"])
    ).toEqual(["qubit-data/fetch_klines"]);
  });
});
