import { describe, expect, test } from "bun:test";
import { listLoadedRecipes, mapRecipeJson } from "./load-recipe-json";
import { resolveScenarioRecipe } from "./scenario-recipe";

describe("load-recipe-json", () => {
  test("stock_pick resolves with version from JSON", () => {
    const recipe = resolveScenarioRecipe("stock_pick");
    expect(recipe).not.toBeNull();
    expect(recipe!.key).toBe("stock_pick");
    expect(recipe!.version).toBe("2026-08-05.3");
    expect(recipe!.roleToolAllowlist?.orchestrator).toContain("agent.invoke");
    expect(recipe!.roleToolAllowlist?.orchestrator).toContain("topology.dispatch");
    expect(recipe!.checklistPrompt.some((l) => l.includes("run_screener"))).toBe(true);
  });

  test("listLoadedRecipes includes stock_pick from crates JSON", () => {
    const list = listLoadedRecipes();
    expect(list.some((r) => r.key === "stock_pick")).toBe(true);
    expect(list.some((r) => r.key === "strategy")).toBe(true);
    expect(list.some((r) => r.key === "research")).toBe(true);
    expect(list.some((r) => r.key === "live_trading")).toBe(true);
  });

  test("mapRecipeJson maps snake_case fields", () => {
    const mapped = mapRecipeJson({
      key: "x",
      aliases: ["y"],
      version: "1",
      stall_budget: {
        tools: ["a"],
        key: "tool_fingerprint",
        max_success: 2,
        on_exceed: "strip_from_surface",
      },
      recovery: {
        after_probe_failure: "continue_without_realtime",
        forbid_gap_as_final_answer: true,
      },
      completion: {
        artifacts: [{ table: "t", min_rows: 1, scope: "workflow" }],
        required_tools: [{ capability: "c", min_success: 1 }],
        answer_schema: { required_sections: ["goal"] },
      },
      checklist_prompt: ["hi"],
    });
    expect(mapped.stallBudget.maxSuccess).toBe(2);
    expect(mapped.completion.artifacts[0]?.minRows).toBe(1);
    expect(mapped.completion.requiredTools[0]?.minSuccess).toBe(1);
  });
});
