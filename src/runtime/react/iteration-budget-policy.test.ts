import { describe, expect, test } from "bun:test";
import {
  didTurnMakeProgress,
  nextUnproductiveTurnCount,
  shouldStopForUnproductiveTurns,
} from "./iteration-budget-policy";

describe("iteration budget policy", () => {
  test("a successful tool result resets the unproductive budget", () => {
    expect(
      didTurnMakeProgress({
        beforeAct: { toolCalls: [], observations: [] },
        afterObserve: {
          toolCalls: [{ toolName: "fetch_klines", status: "success" }],
          observations: [],
        },
      })
    ).toBe(true);
    expect(nextUnproductiveTurnCount({ previous: 2, madeProgress: true })).toBe(0);
  });

  test("failed, blocked and deduplicated turns consume the budget", () => {
    for (const status of ["failed", "blocked_by_sandbox", "deduplicated"]) {
      expect(
        didTurnMakeProgress({
          beforeAct: { toolCalls: [], observations: [] },
          afterObserve: { toolCalls: [{ toolName: "fetch_klines", status }], observations: [] },
        })
      ).toBe(false);
    }
    expect(nextUnproductiveTurnCount({ previous: 1, madeProgress: false })).toBe(2);
  });

  test("a successful plan update does not reset the evidence budget", () => {
    expect(
      didTurnMakeProgress({
        beforeAct: { toolCalls: [], observations: [] },
        afterObserve: {
          toolCalls: [{ toolName: "update_plan", status: "success" }],
          observations: [],
        },
      })
    ).toBe(false);
  });

  test("terminal recovery hints cannot consume the entire hard iteration cap", () => {
    expect(
      didTurnMakeProgress({
        beforeAct: { toolCalls: [], observations: [] },
        afterObserve: {
          toolCalls: [],
          observations: [{ code: "REQUIRED_TOOL_GATE_NOT_ATTEMPTED" }],
        },
      })
    ).toBe(false);
    expect(shouldStopForUnproductiveTurns({ consecutiveUnproductiveTurns: 2 })).toBe(false);
    expect(shouldStopForUnproductiveTurns({ consecutiveUnproductiveTurns: 3 })).toBe(true);
  });
});
