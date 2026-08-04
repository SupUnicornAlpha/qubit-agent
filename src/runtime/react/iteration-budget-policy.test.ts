import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE_TURNS,
  didTurnMakeProgress,
  isLlmGatewayFailureText,
  nextUnproductiveTurnCount,
  shouldRecoverFromUnproductiveBudget,
  shouldStopForUnproductiveTurns,
} from "./iteration-budget-policy";

describe("iteration-budget-policy", () => {
  test("update_plan success does not count as evidence progress", () => {
    expect(
      didTurnMakeProgress({
        beforeAct: { toolCalls: [], observations: [] },
        afterObserve: {
          toolCalls: [{ status: "success", toolName: "update_plan" } as never],
          observations: [],
        },
      })
    ).toBe(false);
  });

  test("business tool success resets unproductive streak", () => {
    expect(nextUnproductiveTurnCount({ previous: 3, madeProgress: true })).toBe(0);
    expect(nextUnproductiveTurnCount({ previous: 3, madeProgress: false })).toBe(4);
  });

  test("default stop threshold is 4", () => {
    expect(DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE_TURNS).toBe(4);
    expect(
      shouldStopForUnproductiveTurns({ consecutiveUnproductiveTurns: 3 })
    ).toBe(false);
    expect(
      shouldStopForUnproductiveTurns({ consecutiveUnproductiveTurns: 4 })
    ).toBe(true);
  });

  test("detects gateway failure text", () => {
    expect(isLlmGatewayFailureText("LLM gateway error: circuit breaker open")).toBe(true);
    expect(isLlmGatewayFailureText("综合结论：观望")).toBe(false);
  });

  test("recovers unproductive budget when research floor unmet", () => {
    expect(
      shouldRecoverFromUnproductiveBudget({
        researchFloorMet: false,
        notAttemptedCapabilities: ["recommendation.record"],
        missingArtifactTables: [],
        unproductiveRecoveryCount: 0,
      })
    ).toBe(true);
    expect(
      shouldRecoverFromUnproductiveBudget({
        researchFloorMet: false,
        notAttemptedCapabilities: ["recommendation.record"],
        missingArtifactTables: [],
        unproductiveRecoveryCount: 2,
      })
    ).toBe(false);
    expect(
      shouldRecoverFromUnproductiveBudget({
        researchFloorMet: true,
        notAttemptedCapabilities: [],
        missingArtifactTables: [],
        unproductiveRecoveryCount: 0,
      })
    ).toBe(false);
  });
});
