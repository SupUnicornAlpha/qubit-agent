import { describe, expect, test } from "bun:test";
import { classifyMcpFailure } from "../dispatcher";

describe("classifyMcpFailure", () => {
  test("caller and data errors do not retry or poison server health", () => {
    for (const message of [
      "Unknown tool: get_stock_info",
      "validation error: ticker is required",
      'mcp server "fsi-mtnewswires" not found or disabled',
      "market_data_unavailable: no eligible source",
    ]) {
      expect(classifyMcpFailure(new Error(message))).toEqual({
        retryable: false,
        circuitRelevant: false,
        healthStatus: "failed",
      });
    }
  });

  test("transport and timeout failures remain retryable and circuit-relevant", () => {
    expect(classifyMcpFailure(new Error("MCP RPC timeout after 30000ms"))).toEqual({
      retryable: true,
      circuitRelevant: true,
      healthStatus: "timeout",
    });
    expect(classifyMcpFailure(new Error("子进程在 tools/call 阶段提前退出"))).toEqual({
      retryable: true,
      circuitRelevant: true,
      healthStatus: "failed",
    });
  });
});
