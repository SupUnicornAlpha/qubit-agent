import { describe, expect, test } from "bun:test";
import {
  buildNotAttemptedDataGaps,
  classifyDataGap,
  toolMatchesRequiredCapability,
} from "./data-gap";

describe("data gap taxonomy", () => {
  const base = { toolName: "qubit-data/fetch_quote", params: { symbol: "AAPL" } };

  test("separates a missing realtime provider from no data", () => {
    expect(
      classifyDataGap({
        ...base,
        message: "market_data_unavailable: real-time quote source is not configured for market=US",
      })
    ).toMatchObject({ kind: "unconfigured", market: "US", retryable: false });
  });

  test("classifies empty fundamentals as coverage rather than a permanent transport failure", () => {
    expect(
      classifyDataGap({
        toolName: "qubit-data/fetch_fundamentals",
        params: { symbol: "AAPL" },
        message: "semantic_data_failure:periods_empty",
      })
    ).toMatchObject({ kind: "no_coverage", retryable: false });
  });

  test("keeps retryable provider outages distinct", () => {
    expect(
      classifyDataGap({
        ...base,
        message: "market_data_unavailable: all 2 source(s) failed: ECONNRESET",
      })
    ).toMatchObject({ kind: "transient", retryable: true });
  });

  test("does not turn arbitrary errors into data gaps", () => {
    expect(classifyDataGap({ ...base, message: "factor database invariant violated" })).toBeNull();
  });

  test("keeps a required but never-called capability distinct from no data", () => {
    const gaps = buildNotAttemptedDataGaps({
      requiredCapabilities: ["screener", "recommendation.record"],
      attemptedTools: ["run_screener"],
      market: "US",
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ kind: "not_attempted", capability: "recommendation.record" });
  });

  test("accepts a historical market snapshot as price evidence, but not as news evidence", () => {
    expect(toolMatchesRequiredCapability("qubit-data/fetch_klines", "get_quote")).toBe(true);
    expect(toolMatchesRequiredCapability("qubit-data/fetch_klines", "news")).toBe(false);
  });

  test("does not treat evaluate_risk as an order capability", () => {
    expect(toolMatchesRequiredCapability("evaluate_risk", "risk")).toBe(true);
    expect(toolMatchesRequiredCapability("evaluate_risk", "order")).toBe(false);
  });

  test("factor.list is inventory-only and does not satisfy the factor write contract", () => {
    expect(toolMatchesRequiredCapability("factor.list", "factor")).toBe(false);
    expect(toolMatchesRequiredCapability("factor.register", "factor")).toBe(true);
    expect(toolMatchesRequiredCapability("factor.autoEvaluate", "factor")).toBe(false);
  });

  test("order.create_intent satisfies risk because it embeds pre-trade risk_decision", () => {
    expect(toolMatchesRequiredCapability("order.create_intent", "order")).toBe(true);
    expect(toolMatchesRequiredCapability("order.create_intent", "risk")).toBe(true);
  });

  test("investor-agent MCP tools count as get_quote capability", () => {
    expect(
      toolMatchesRequiredCapability("mcp:investor-agent:historical_prices", "get_quote")
    ).toBe(true);
    expect(
      toolMatchesRequiredCapability("mcp:investor-agent:technical_indicator", "get_quote")
    ).toBe(true);
    expect(toolMatchesRequiredCapability("mcp:investor-agent:get_stock_info", "get_quote")).toBe(
      true
    );
  });
});
