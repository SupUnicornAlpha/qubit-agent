import { describe, expect, test } from "bun:test";
import { decideTerminalControl } from "./terminal-turn-decision";

describe("terminal turn decision", () => {
  test("asks an orchestrator in plan mode to persist a plan before finishing", () => {
    const decision = decideTerminalControl({
      role: "orchestrator",
      agentMode: "plan",
      processConfig: null,
      planSnapshot: null,
      toolCalls: [],
      controlModeGapRetryCount: 0,
      cleanedReason: "draft plan",
    });

    expect(decision).toMatchObject({
      kind: "continue",
      controlModeGapRetryCount: 1,
      observation: { code: "PLAN_REQUIRED" },
    });
  });

  test("turns an exhausted goal gate into a deterministic terminal decision", () => {
    const decision = decideTerminalControl({
      role: "orchestrator",
      agentMode: "goal",
      processConfig: null,
      planSnapshot: null,
      toolCalls: [],
      controlModeGapRetryCount: 2,
      cleanedReason: "no evidence",
    });

    expect(decision).toMatchObject({
      kind: "terminate",
      reason: "control_mode_gate_unsatisfied",
      observation: { code: "CONTROL_MODE_GATE_UNSATISFIED" },
    });
  });
});
