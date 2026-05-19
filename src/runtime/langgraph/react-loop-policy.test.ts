import { describe, expect, test } from "bun:test";
import type { RuntimeAgentDefinition } from "../types";
import { resolveForceReactLoop, shouldStopReactLoopAfterObserve } from "./react-loop-policy";
import type { AgentGraphState } from "./state";

const baseDef: RuntimeAgentDefinition = {
  id: "def-test",
  role: "analyst_fundamental",
  name: "Test",
  version: "1",
  systemPrompt: "",
  tools: ["fetch_klines"],
  mcpServers: [],
  skills: [],
  subscriptions: ["TASK_ASSIGN"],
  llmProvider: "mock",
  maxIterations: 10,
  sandboxPolicyId: "default-policy",
  enabled: true,
};

describe("resolveForceReactLoop", () => {
  test("maxIterations>1 enables multi-turn by default", () => {
    expect(resolveForceReactLoop({ def: baseDef })).toBe(true);
    expect(
      resolveForceReactLoop({
        def: { ...baseDef, tools: [], mcpServers: [] },
      })
    ).toBe(true);
  });

  test("maxIterations=1 is single round", () => {
    expect(resolveForceReactLoop({ def: { ...baseDef, maxIterations: 1 } })).toBe(false);
  });

  test("explicit forceLoop false disables", () => {
    expect(
      resolveForceReactLoop({
        def: baseDef,
        payloadParams: { forceLoop: false },
      })
    ).toBe(false);
  });

  test("workflow reactLoop false disables", () => {
    expect(
      resolveForceReactLoop({
        def: baseDef,
        loopOptions: { reactLoop: false },
      })
    ).toBe(false);
  });
});

describe("shouldStopReactLoopAfterObserve", () => {
  test("stops when tool none", () => {
    const state = {
      plannedAction: "respond_only",
      observations: [{ skippedToolCall: true }],
    } as unknown as AgentGraphState;
    expect(shouldStopReactLoopAfterObserve(state)).toBe(true);
  });
});
