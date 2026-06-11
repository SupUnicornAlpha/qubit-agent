import { describe, expect, it } from "bun:test";
import { resolveExecutionPath } from "../resolve-execution-path";

describe("resolveExecutionPath", () => {
  it("native workflows always resolve to a2a (graph dispatch removed)", () => {
    expect(resolveExecutionPath({ loopKind: "native" })).toBe("a2a");
  });

  it("native ignores legacy execution_path='graph' and still resolves a2a", () => {
    expect(
      resolveExecutionPath({ loopKind: "native", executionPath: "graph" })
    ).toBe("a2a");
  });

  it("native ignores loop_options executionPath override, still a2a", () => {
    expect(
      resolveExecutionPath({
        loopKind: "native",
        executionPath: "graph",
        loopOptionsJson: { executionPath: "graph" },
      })
    ).toBe("a2a");
  });

  it("CLI loops return the 'graph' placeholder (routed via CLI driver, not LangGraph)", () => {
    expect(
      resolveExecutionPath({
        loopKind: "claude_cli",
        executionPath: "a2a",
      })
    ).toBe("graph");
  });
});
