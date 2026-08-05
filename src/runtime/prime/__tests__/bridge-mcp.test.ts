import { describe, expect, test } from "bun:test";
import {
  formatMcpBridgeToolName,
  isMcpBridgeToolName,
  parseMcpBridgeToolName,
  resolveMcpInvokeTarget,
} from "../bridge-mcp";

describe("bridge-mcp", () => {
  test("parse mcp:<server>:<tool>", () => {
    expect(parseMcpBridgeToolName("mcp:mathjs:add")).toEqual({
      serverName: "mathjs",
      toolName: "add",
    });
    expect(parseMcpBridgeToolName("mcp:bad")).toBeNull();
    expect(parseMcpBridgeToolName("market.resolve_symbol")).toBeNull();
  });

  test("isMcpBridgeToolName", () => {
    expect(isMcpBridgeToolName("call_mcp")).toBe(true);
    expect(isMcpBridgeToolName("mcp:s:t")).toBe(true);
    expect(isMcpBridgeToolName("market.readiness")).toBe(false);
  });

  test("resolve call_mcp nested arguments", () => {
    expect(
      resolveMcpInvokeTarget("call_mcp", {
        serverName: "mathjs",
        toolName: "add",
        arguments: { a: 1, b: 2 },
      })
    ).toEqual({
      serverName: "mathjs",
      toolName: "add",
      arguments: { a: 1, b: 2 },
    });
  });

  test("resolve call_mcp with mcpTool alias + flat args", () => {
    expect(
      resolveMcpInvokeTarget("call_mcp", {
        server_name: "mathjs",
        mcpTool: "add",
        a: 1,
        b: 2,
      })
    ).toEqual({
      serverName: "mathjs",
      toolName: "add",
      arguments: { a: 1, b: 2 },
    });
  });

  test("resolve direct wire name", () => {
    expect(
      resolveMcpInvokeTarget("mcp:mathjs:add", { a: 1 })
    ).toEqual({
      serverName: "mathjs",
      toolName: "add",
      arguments: { a: 1 },
    });
    expect(formatMcpBridgeToolName("mathjs", "add")).toBe("mcp:mathjs:add");
  });
});
