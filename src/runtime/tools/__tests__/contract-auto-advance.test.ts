import { describe, expect, test } from "bun:test";
import type { ScenarioRuntimeSnapshot } from "../../policy/scenario-snapshot";
import { resolveArtifactAutoAdvance } from "../contract-auto-advance";

function snapshot(overrides: Partial<ScenarioRuntimeSnapshot> = {}): ScenarioRuntimeSnapshot {
  return {
    workflowId: "wf-contract-auto-advance",
    scenarioKey: "strategy",
    recipe: null,
    authorizedTools: [],
    attemptedTools: [],
    successfulTools: [],
    notAttemptedCapabilities: [],
    unavailableCapabilities: [],
    missingArtifactTables: [],
    missingArtifacts: [],
    artifactsOk: false,
    researchArtifactsOk: false,
    factorDefinitionCount: 1,
    activeFactorIds: ["factor-1"],
    latestFactorDefinitionId: "factor-1",
    screenerTopSymbol: null,
    strategyVersionId: null,
    loadedAtMs: Date.now(),
    ...overrides,
  };
}

describe("resolveArtifactAutoAdvance", () => {
  test("creates a version before suggesting composition when none exists", () => {
    const result = resolveArtifactAutoAdvance({
      snapshot: snapshot({ missingArtifactTables: ["strategy_composition"] }),
      availableTools: ["strategy.create_version", "strategy.compose"],
    });
    expect(result?.toolName).toBe("strategy.create_version");
    expect(result?.params.name).toContain("recovery-strategy");
  });

  test("includes strategy_version_id in the composition recovery draft", () => {
    const result = resolveArtifactAutoAdvance({
      snapshot: snapshot({
        strategyVersionId: "sv-1",
        missingArtifactTables: ["strategy_composition"],
      }),
      availableTools: ["strategy.compose"],
    });
    expect(result).toEqual({
      toolName: "strategy.compose",
      params: {
        strategy_version_id: "sv-1",
        kind: "factor_weighted",
        weight_method: "equal",
        factor_ids: ["factor-1"],
      },
    });
  });

  test("includes strategy_version_id in the backtest recovery draft", () => {
    const result = resolveArtifactAutoAdvance({
      snapshot: snapshot({
        strategyVersionId: "sv-1",
        missingArtifactTables: ["quality:strategy_backtest_completed"],
      }),
      availableTools: ["backtest.run"],
    });
    expect(result?.toolName).toBe("backtest.run");
    expect(result?.params.strategy_version_id).toBe("sv-1");
    expect(result?.params.symbols).toEqual(["AAPL", "MSFT", "NVDA"]);
  });
});
