import { describe, expect, test } from "bun:test";
import { filterMcpToolsByAvailability } from "../resolve-enabled-mcp-servers";

describe("filterMcpToolsByAvailability", () => {
  test("removes every MCP entry point when no server is enabled", () => {
    expect(
      filterMcpToolsByAvailability(
        ["fetch_news", "call_mcp", "mcp:fsi-mtnewswires:get_latest_headlines"],
        []
      )
    ).toEqual(["fetch_news"]);
  });

  test("removes call_mcp and keeps only direct tools for enabled servers", () => {
    expect(
      filterMcpToolsByAvailability(
        ["fetch_news", "call_mcp", "mcp:fsi-mtnewswires:get_latest_headlines", "mcp:mathjs:add"],
        ["mathjs"]
      )
    ).toEqual(["fetch_news", "mcp:mathjs:add"]);
  });
});
