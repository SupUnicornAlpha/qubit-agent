import { describe, expect, test } from "bun:test";
import { decideTerminalControl, looksLikeDeferredToolIntent } from "./terminal-turn-decision";

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

  test("agent mode: deferred tool intent without evidence forces another reason turn", () => {
    const decision = decideTerminalControl({
      role: "orchestrator",
      agentMode: "agent",
      processConfig: null,
      planSnapshot: null,
      toolCalls: [],
      controlModeGapRetryCount: 0,
      cleanedReason:
        "收到。目标：A 股兆易创新近期操作研究。先建计划，并立即并行补齐行情快照 + 新闻事件两类基础证据。",
    });
    expect(decision).toMatchObject({
      kind: "continue",
      controlModeGapRetryCount: 1,
      observation: { code: "DEFERRED_TOOL_INTENT" },
    });
  });

  test("agent mode: after deferred retries exhausted, allow tool=none terminal", () => {
    const decision = decideTerminalControl({
      role: "orchestrator",
      agentMode: "agent",
      processConfig: null,
      planSnapshot: null,
      toolCalls: [],
      controlModeGapRetryCount: 2,
      cleanedReason: "先建计划，并立即并行补齐行情快照",
    });
    expect(decision).toEqual({ kind: "allow" });
  });

  test("agent mode: real conclusion without deferred verbs is allowed", () => {
    const decision = decideTerminalControl({
      role: "orchestrator",
      agentMode: "agent",
      processConfig: null,
      planSnapshot: null,
      toolCalls: [],
      controlModeGapRetryCount: 0,
      cleanedReason: "综合结论：短期以观察为主，不建议追高；等待回踩支撑。",
    });
    expect(decision).toEqual({ kind: "allow" });
  });

  test("agent mode: deferred still blocked when research floor unmet after partial tools", () => {
    const decision = decideTerminalControl({
      role: "orchestrator",
      agentMode: "agent",
      processConfig: null,
      planSnapshot: null,
      toolCalls: [{ status: "success", toolName: "run_screener" }],
      controlModeGapRetryCount: 0,
      cleanedReason: "筛候选 → 拉行情 → 逐只落 recommendation.record",
      researchFloorMet: false,
    });
    expect(decision).toMatchObject({
      kind: "continue",
      observation: { code: "DEFERRED_TOOL_INTENT", researchFloorMet: false },
    });
  });

  test("LLM gateway failure text forces another reason turn", () => {
    const decision = decideTerminalControl({
      role: "orchestrator",
      agentMode: "agent",
      processConfig: null,
      planSnapshot: null,
      toolCalls: [],
      controlModeGapRetryCount: 0,
      cleanedReason: "LLM gateway error: 503 Service is too busy.",
    });
    expect(decision).toMatchObject({
      kind: "continue",
      observation: { code: "LLM_GATEWAY_TRANSIENT" },
    });
  });
});

describe("looksLikeDeferredToolIntent", () => {
  test("matches the fake-complete f22 announcement", () => {
    expect(
      looksLikeDeferredToolIntent(
        "先建计划，并立即并行补齐**行情快照 + 新闻事件**两类基础证据。"
      )
    ).toBe(true);
  });

  test("does not match plain conclusion", () => {
    expect(looksLikeDeferredToolIntent("最终建议：减仓观望。")).toBe(false);
  });

  test("matches strategy contract narration", () => {
    expect(
      looksLikeDeferredToolIntent(
        "我先按场景合同执行策略基建步骤：创建策略版本，再尝试组合三因子。"
      )
    ).toBe(true);
  });
});
