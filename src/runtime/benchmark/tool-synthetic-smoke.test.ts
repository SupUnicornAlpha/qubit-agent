import { describe, expect, test } from "bun:test";
import { QUBIT_BENCH_CASES } from "./qubit-bench-cases";
import { runGlobalToolSyntheticSmoke } from "./tool-synthetic-smoke";

describe("global benchmark and per-tool synthetic smoke", () => {
  test("exports one stable 20-case suite", () => {
    expect(QUBIT_BENCH_CASES).toHaveLength(20);
    expect(new Set(QUBIT_BENCH_CASES.map((item) => item.id)).size).toBe(20);
  });

  test("every globally exposed tool and dynamic/MCP surface resolves", () => {
    const results = runGlobalToolSyntheticSmoke({
      topologyTools: ["call_team_research", "call_team_risk"],
      enabledMcpServers: ["investor-agent", "mathjs"],
    });
    expect(results.length).toBeGreaterThan(50);
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.some((result) => result.name === "agent.invoke")).toBe(true);
    expect(results.some((result) => result.name === "mcp:mathjs:*")).toBe(true);
  });
});
