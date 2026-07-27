import { describe, expect, test } from "bun:test";
import { classifyToolErrorCode } from "./tool-call-log-service";

describe("classifyToolErrorCode", () => {
  test("gives MCP failures actionable stable codes", () => {
    expect(classifyToolErrorCode("mcp", "Unknown tool: nope")).toBe("mcp_unknown_tool");
    expect(classifyToolErrorCode("mcp", "ticker is required")).toBe("mcp_invalid_arguments");
    expect(classifyToolErrorCode("mcp", "MCP RPC timeout")).toBe("mcp_timeout");
    expect(classifyToolErrorCode("mcp", "子进程提前退出")).toBe("mcp_transport_exit");
    expect(classifyToolErrorCode("mcp", "server not found or disabled")).toBe(
      "mcp_server_disabled"
    );
  });

  test("keeps the legacy source code for non-MCP failures", () => {
    expect(classifyToolErrorCode("connector", "boom")).toBe("connector_call_failed");
  });
});
