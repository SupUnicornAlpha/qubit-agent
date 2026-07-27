import { describe, expect, test } from "bun:test";
import { isMcpFallbackResponse } from "../mcp-summary";

describe("isMcpFallbackResponse", () => {
  test("recognizes persisted act-node MCP fallback payloads", () => {
    expect(
      isMcpFallbackResponse({
        result: "ok",
        mcpResult: {
          output: {
            __mcp_fallback: { original_server: "mcp-financex", routed_to: "qubit-data" },
          },
        },
      })
    ).toBe(true);
  });

  test("does not mark native MCP output as fallback", () => {
    expect(isMcpFallbackResponse({ mcpResult: { output: { price: 100 } } })).toBe(false);
  });
});
