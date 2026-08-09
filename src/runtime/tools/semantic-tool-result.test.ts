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

  test("does not reject successful snapshots because optional arrays are empty", () => {
    expect(
      detectSemanticToolFailure("market.snapshot.get", {
        builtinResult: {
          ok: true,
          snapshotId: "mkt_snapshot_1",
          warnings: [],
          snapshot: { corporateActions: [] },
        },
      })
    ).toBeNull();
  });

  test("keeps partial financial data when price evidence exists", () => {
    expect(
      detectSemanticToolFailure("fetch_financial_data", {
        connectorResult: {
          symbol: "603986.SH",
          barCount: 120,
          priceStats: { lastClose: 100 },
          fundamentals: { periods: [] },
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

  test("does not misclassify team dispatch timeout as market data outage", () => {
    expect(
      detectSemanticToolFailure("call_team_market_data", {
        builtinResult: {
          dispatched: true,
          completed: false,
          success: false,
          dispatchStatus: "timeout",
          dataAvailability: "unknown",
          errorMessage: "team_dispatch_timeout: market_data 专家未回包；这不代表底层数据源不可用",
        },
      })
    ).toBe("dispatch_timeout_data_unknown");
  });

  test("does not treat unproductive budget stop as semantic data failure", () => {
    expect(
      detectSemanticToolFailure("call_team_market_data", {
        builtinResult: {
          dispatched: true,
          completed: true,
          success: false,
          errorCode: "unproductive_turn_budget_exhausted",
          errorMessage: "收到。目标明确：…",
          partialEvidence: true,
        },
      })
    ).toBeNull();
    expect(
      detectSemanticToolFailure("call_team_market_data", {
        builtinResult: {
          dispatched: true,
          completed: true,
          success: false,
          errorCode: "unproductive_turn_budget_exhausted",
          errorMessage: "收到。目标明确：…",
        },
      })
    ).toBeNull();
  });

  test("uses a TaskResult v2 error code instead of an unstructured fallback", () => {
    expect(
      detectSemanticToolFailure("call_team_analyst_technical", {
        builtinResult: {
          dispatched: true,
          completed: true,
          success: false,
          taskStatus: "failed",
          errorCode: "task_deadline_exceeded",
          errorMessage: "specialist deadline elapsed",
        },
      })
    ).toBe("task_deadline_exceeded");
  });

  test("keeps verified partial topology evidence available to the parent", () => {
    expect(
      detectSemanticToolFailure("call_team_analyst_technical", {
        builtinResult: {
          dispatched: true,
          completed: true,
          success: true,
          taskStatus: "partial",
          partialEvidence: true,
          result: { taskEvidence: { verified: true, kind: "tool_result" } },
        },
      })
    ).toBeNull();
  });

  test("marks MCP isError + Invalid arguments as validation failure", () => {
    expect(
      detectSemanticToolFailure("mcp:investor-agent:get_stock_info", {
        accepted: true,
        output: {
          isError: true,
          content: [
            {
              type: "text",
              text: 'MCP error -32602: Invalid arguments for tool get_stock_info: [{"path":["modules"],"message":"Required"}]',
            },
          ],
        },
      })
    ).toBe("mcp_validation_error");
  });

  test("unwraps bridge-shaped mcpResult with isError", () => {
    expect(
      detectSemanticToolFailure("mcp:investor-agent:get_stock_info", {
        mcpResult: {
          accepted: true,
          output: {
            isError: true,
            content: [{ type: "text", text: "MCP error -32602: Invalid arguments" }],
          },
        },
      })
    ).toBe("mcp_validation_error");
  });
});
