import { describe, expect, test } from "bun:test";
import { decideToolNoneGate } from "./scenario-gate";
import { resolveScenarioRecipe } from "./scenario-recipe";
import type { ScenarioRuntimeSnapshot } from "./scenario-snapshot";

const snapshot: ScenarioRuntimeSnapshot = {
  workflowId: "wf-1",
  scenarioKey: "live_trading",
  recipe: resolveScenarioRecipe("live_trading"),
  authorizedTools: ["strategy.create_version", "order.create_intent"],
  attemptedTools: [],
  successfulTools: [],
  notAttemptedCapabilities: ["order"],
  unavailableCapabilities: [],
  missingArtifactTables: [],
  missingArtifacts: [],
  artifactsOk: true,
  factorDefinitionCount: 0,
  activeFactorIds: [],
  latestFactorDefinitionId: null,
  screenerTopSymbol: null,
  strategyVersionId: null,
  loadedAtMs: 0,
};

describe("scenario gate", () => {
  test("decides required-tool recovery from a snapshot without a database adapter", () => {
    const decision = decideToolNoneGate({
      snapshot,
      availableTools: snapshot.authorizedTools,
      goal: "paper buy AAPL",
      requiredToolRetryCount: 0,
      artifactRetryCount: 0,
      maxRequiredToolRetries: 4,
      maxArtifactRetries: 4,
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
      unavailableRequired: [],
      artifactOk: true,
      artifactMissing: [],
    });

    expect(decision.kind).toBe("push_back");
    if (decision.kind !== "push_back") return;
    expect(decision.recovery.mode).toBe("hint_only");
    expect(decision.recovery.nextTool).toBe("strategy.create_version");
  });

  test("uses snapshot artifact details for a partial stop", () => {
    const decision = decideToolNoneGate({
      snapshot: {
        ...snapshot,
        missingArtifactTables: ["order_intent"],
        missingArtifacts: [{ table: "order_intent", rows: 0, minRows: 1 }],
        artifactsOk: false,
        strategyVersionId: "sv-1",
      },
      availableTools: snapshot.authorizedTools,
      requiredToolRetryCount: 0,
      artifactRetryCount: 4,
      maxRequiredToolRetries: 4,
      maxArtifactRetries: 4,
      notAttempted: [],
      unavailableRequired: [],
      artifactOk: false,
      artifactMissing: [{ table: "order_intent", rows: 0, minRows: 1 }],
    });

    expect(decision).toMatchObject({
      kind: "partial_stop",
      code: "ARTIFACT_GATE_UNSATISFIED",
    });
  });

  test("allows finalize when the research floor is met; upgrade underfill is a delivery-quality gap", () => {
    const decision = decideToolNoneGate({
      snapshot: {
        ...snapshot,
        scenarioKey: "stock_pick",
        recipe: resolveScenarioRecipe("stock_pick"),
        authorizedTools: ["run_screener", "recommendation.record"],
        attemptedTools: ["run_screener", "recommendation.record"],
        successfulTools: ["run_screener", "recommendation.record"],
        screenerTopSymbol: "NVDA",
        screenerCandidateSymbols: ["NVDA", "AVGO", "MSFT"],
        recommendationSymbols: ["NVDA"],
        missingArtifactTables: ["recommendation_snapshot"],
        missingArtifacts: [{ table: "recommendation_snapshot", rows: 1, minRows: 3 }],
        artifactsOk: false,
        researchArtifactsOk: true,
      },
      availableTools: ["recommendation.record"],
      requiredToolRetryCount: 0,
      artifactRetryCount: 0,
      maxRequiredToolRetries: 4,
      maxArtifactRetries: 4,
      notAttempted: [],
      unavailableRequired: [],
      // Product runtime passes research-floor, not upgrade-grade, completeness.
      artifactOk: true,
      artifactMissing: [{ table: "recommendation_snapshot", rows: 1, minRows: 3 }],
    });

    expect(decision).toEqual({ kind: "allow_finalize" });
  });

  test("requires a market-data read before stock-pick can finalize", () => {
    const decision = decideToolNoneGate({
      snapshot: {
        ...snapshot,
        scenarioKey: "stock_pick",
        recipe: resolveScenarioRecipe("stock_pick"),
        authorizedTools: ["run_screener", "fetch_klines", "recommendation.record"],
      },
      availableTools: ["fetch_klines", "recommendation.record"],
      goal: "筛选美股 long 候选并给出交易计划",
      requiredToolRetryCount: 0,
      artifactRetryCount: 0,
      maxRequiredToolRetries: 4,
      maxArtifactRetries: 4,
      notAttempted: [
        {
          kind: "not_attempted",
          capability: "get_quote",
          market: "US",
          provider: null,
          reason: "not attempted",
          retryable: true,
        },
      ],
      unavailableRequired: [],
      artifactOk: true,
      artifactMissing: [],
    });

    expect(decision).toMatchObject({
      kind: "push_back",
      code: "REQUIRED_TOOL_GATE_NOT_ATTEMPTED",
      recovery: { nextTool: "fetch_klines" },
    });
  });
});
