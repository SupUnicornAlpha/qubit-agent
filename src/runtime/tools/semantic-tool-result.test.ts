import { describe, expect, test } from "bun:test";
import { detectSemanticToolFailure } from "./semantic-tool-result";

describe("detectSemanticToolFailure", () => {
  test("marks empty connector bars as semantic failure", () => {
    expect(
      detectSemanticToolFailure("qubit-data/fetch_klines", {
        result: "ok",
        connectorResult: [],
      })
    ).toBe("semantic_empty_result");
  });

  test("marks nested MCP no_bars as semantic failure", () => {
    expect(
      detectSemanticToolFailure("mcp-financex/get_quote_batch", {
        result: "ok",
        mcpResult: { output: { quotes: [{ symbol: "AAPL", error: "no_bars" }] } },
      })
    ).toBe("no_bars");
  });

  test("does not reject non-data tools or populated data", () => {
    expect(
      detectSemanticToolFailure("factor.register", { builtinResult: { id: "f1" } })
    ).toBeNull();
    expect(
      detectSemanticToolFailure("fetch_news", { connectorResult: [{ title: "real" }] })
    ).toBeNull();
  });

  test("marks nested MCP error payload as failure even when transport accepted it", () => {
    expect(
      detectSemanticToolFailure("mcp-financex/get_quote", {
        result: "ok",
        mcpResult: {
          accepted: true,
          output: { symbol: "002384.SZ", error: "market_data_unavailable: all providers failed" },
        },
      })
    ).toBe("nested_error:market_data_unavailable");
  });

  test("marks an all-synthetic news result as failure", () => {
    expect(
      detectSemanticToolFailure("qubit-news/fetch_news", {
        connectorResult: { items: [{ title: "stub", isSynthetic: true }] },
      })
    ).toBe("synthetic_data");
  });

  test("allows a partially successful batch", () => {
    expect(
      detectSemanticToolFailure("mcp-financex/get_quote_batch", {
        mcpResult: {
          output: {
            quotes: [
              { symbol: "AAPL", price: 100 },
              { symbol: "BAD", error: "upstream unavailable" },
            ],
          },
        },
      })
    ).toBeNull();
  });

  test("marks a timed-out topology child as semantic failure", () => {
    expect(
      detectSemanticToolFailure("call_team_analyst_technical", {
        builtinResult: {
          dispatched: true,
          completed: false,
          success: false,
          errorMessage: "a2a_gather_timeout",
        },
      })
    ).toBe("nested_error:a2a_gather_timeout");
  });
});
