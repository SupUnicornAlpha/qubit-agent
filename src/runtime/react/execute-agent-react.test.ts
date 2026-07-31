import { describe, expect, test } from "bun:test";
import { resolveTerminalStatus } from "./execute-agent-react";

describe("resolveTerminalStatus", () => {
  test("keeps resource-limited answers as partial instead of completed or failed", () => {
    expect(resolveTerminalStatus({ status: "partial", reason: "max_iterations" })).toBe("partial");
    expect(resolveTerminalStatus({ status: "partial", reason: "token_budget_exhausted" })).toBe(
      "partial"
    );
  });

  test("keeps actual exceptions failed and HITL waiting non-terminal", () => {
    expect(resolveTerminalStatus({ status: "terminated", reason: "exception" })).toBe("failed");
    expect(resolveTerminalStatus({ status: "awaiting_approval" })).toBe("awaiting_approval");
  });
});
