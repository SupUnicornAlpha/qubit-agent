import { describe, expect, it } from "bun:test";
import { resolveExecutionPath } from "../resolve-execution-path";

describe("resolveExecutionPath", () => {
  it("defaults native workflows to graph", () => {
    expect(resolveExecutionPath({ loopKind: "native" })).toBe("graph");
  });

  it("uses execution_path column when set", () => {
    expect(
      resolveExecutionPath({ loopKind: "native", executionPath: "a2a" })
    ).toBe("a2a");
  });

  it("loop_options executionPath overrides column", () => {
    expect(
      resolveExecutionPath({
        loopKind: "native",
        executionPath: "graph",
        loopOptionsJson: { executionPath: "a2a" },
      })
    ).toBe("a2a");
  });

  it("CLI loops always use graph driver path", () => {
    expect(
      resolveExecutionPath({
        loopKind: "claude_cli",
        executionPath: "a2a",
      })
    ).toBe("graph");
  });
});
