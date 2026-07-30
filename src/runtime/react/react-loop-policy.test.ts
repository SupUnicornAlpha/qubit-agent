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
  test("stops when last observation is skippedToolCall", () => {
    const state = {
      plannedAction: "respond_only",
      observations: [{ skippedToolCall: true }],
    } as unknown as AgentGraphState;
    expect(shouldStopReactLoopAfterObserve(state)).toBe(true);
  });

  test("stops even when plannedAction='tool_call' (regression: avoid orchestrator loop)", () => {
    /**
     * 这是核心回归：旧实现要求 plannedAction !== 'tool_call' 才停，但 reason
     * 节点在 hasTools=true 时强制写 tool_call → 死循环。fix 后只要观测到
     * skippedToolCall 就停。
     */
    const state = {
      plannedAction: "tool_call",
      observations: [{ skippedToolCall: true }],
    } as unknown as AgentGraphState;
    expect(shouldStopReactLoopAfterObserve(state)).toBe(true);
  });

  test("stops when finalResponse has been set", () => {
    const state = {
      plannedAction: "tool_call",
      observations: [],
      finalResponse: { status: "completed" },
    } as unknown as AgentGraphState;
    expect(shouldStopReactLoopAfterObserve(state)).toBe(true);
  });

  test("does not stop on bare observation without skippedToolCall", () => {
    const state = {
      plannedAction: "tool_call",
      observations: [{ level: "info" }],
    } as unknown as AgentGraphState;
    expect(shouldStopReactLoopAfterObserve(state)).toBe(false);
  });
});
