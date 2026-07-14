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
});
