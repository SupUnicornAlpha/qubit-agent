import { describe, expect, test } from "bun:test";
import { mcpToolErrorFromStderr, mcpToolResultErrorMessage } from "../stdio-session";

describe("mcpToolResultErrorMessage", () => {
  test("isError=false → null", () => {
    expect(mcpToolResultErrorMessage({ content: [{ type: "text", text: "ok" }] })).toBeNull();
  });

  test("isError=true + JSON content → 解析 error/code", () => {
    const msg = mcpToolResultErrorMessage({
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "Failed to get crumb",
            code: "INTERNAL_ERROR",
          }),
        },
      ],
    });
    expect(msg).toBe("INTERNAL_ERROR: Failed to get crumb");
  });

  test("isError=true 无 content → 兜底文案", () => {
    expect(mcpToolResultErrorMessage({ isError: true })).toContain("isError");
  });
});

describe("mcpToolErrorFromStderr", () => {
  test("从 mcp-financex stderr 提取 originalMessage", () => {
    const msg = mcpToolErrorFromStderr([
      "[MCP] Tool error: get_quote FinanceError\n  details: { originalMessage: 'Failed to get crumb, status 403' }\n",
    ]);
    expect(msg).toBe("Failed to get crumb, status 403");
  });
});
