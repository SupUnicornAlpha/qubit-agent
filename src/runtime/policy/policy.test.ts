import { describe, expect, test } from "bun:test";
import { assertAnswerSchema } from "./answer-schema";
import { getContractAutoAdvanceMode, isThinLoopEnabled } from "./flags";
import { resolveScenarioRecipe } from "./scenario-recipe";
import { BUSINESS_WRITE_TOOLS } from "./types";
import { planContractRecovery } from "./recovery";
import type { ScenarioRuntimeSnapshot } from "./scenario-snapshot";

describe("scenario recipes", () => {
  test("resolves aliases to pin-versioned recipes", () => {
    expect(resolveScenarioRecipe("stock_pick")?.key).toBe("stock_pick");
    expect(resolveScenarioRecipe("sp")?.version).toMatch(/^2026-/);
    expect(resolveScenarioRecipe("factor_research")?.key).toBe("factor");
    expect(resolveScenarioRecipe("lt")?.key).toBe("live_trading");
    expect(resolveScenarioRecipe("stock_pick_short")?.key).toBe("stock_pick");
    expect(resolveScenarioRecipe("strategy_long_short")?.key).toBe("strategy");
    expect(resolveScenarioRecipe("live_trading_short")?.key).toBe("live_trading");
  });
});

describe("answer schema", () => {
  test("requires labeled sections", () => {
    const ok = assertAnswerSchema(
      { requiredSections: ["goal", "evidence", "decision", "risks", "gaps"] },
      [
        "## goal",
        "做多 NVDA",
        "## evidence",
        "kline",
        "## decision",
        "buy",
        "## risks",
        "波动",
        "## gaps",
        "无",
      ].join("\n")
    );
    expect(ok.schemaOk).toBe(true);
    expect(ok.missingSections).toEqual([]);
  });

  test("flags missing sections", () => {
    const bad = assertAnswerSchema(
      { requiredSections: ["goal", "evidence", "decision", "risks", "gaps"] },
      "行情不可用，无法继续。"
    );
    expect(bad.schemaOk).toBe(false);
    expect(bad.missingSections.length).toBeGreaterThan(0);
  });
});

describe("flags default to thin loop / hint", () => {
  test("defaults", () => {
    expect(getContractAutoAdvanceMode()).toBe("hint");
    expect(isThinLoopEnabled()).toBe(true);
    expect(BUSINESS_WRITE_TOOLS.has("order.create_intent")).toBe(true);
  });
});

describe("recovery planner", () => {
  test("returns hint-only for business writes", () => {
    const snapshot = {
      workflowId: "wf-1",
      scenarioKey: "live_trading",
      recipe: resolveScenarioRecipe("live_trading"),
      authorizedTools: ["order.create_intent", "strategy.create_version"],
      attemptedTools: [],
      successfulTools: [],
      notAttemptedCapabilities: ["order"],
      unavailableCapabilities: [],
      missingArtifactTables: [],
      missingArtifacts: [],
      artifactsOk: false,
      factorDefinitionCount: 0,
      activeFactorIds: [],
      latestFactorDefinitionId: null,
      screenerTopSymbol: null,
      strategyVersionId: null,
      loadedAtMs: Date.now(),
    } satisfies ScenarioRuntimeSnapshot;

    const suggestion = planContractRecovery({
      snapshot,
      availableTools: ["order.create_intent", "strategy.create_version"],
      goal: "纸面做多 AAPL",
      notAttempted: [
        {
          kind: "not_attempted",
          capability: "order",
          market: "US",
          provider: null,
          reason: "not attempted",
          retryable: true,
        },
      ],
    });

    expect(suggestion.mode).toBe("hint_only");
    expect(suggestion.nextTool).toBeTruthy();
    expect(suggestion.hint).toContain("须由模型");
  });
});
