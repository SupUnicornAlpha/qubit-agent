/**
 * MemoryConsolidationService 纯函数测试 — M10.A1
 */

import { describe, expect, test } from "bun:test";
import {
  inferMemoryType,
  summarizeAgentSteps,
  type AgentStepRow,
} from "../memory-consolidation";

function mkStep(overrides: Partial<AgentStepRow>): AgentStepRow {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    agentInstanceId: overrides.agentInstanceId ?? "i1",
    stepIndex: overrides.stepIndex ?? 0,
    phase: overrides.phase ?? "reason",
    thought: overrides.thought ?? null,
    actionType: overrides.actionType ?? "tool_call",
    actionJson: overrides.actionJson ?? {},
    observationJson: overrides.observationJson ?? null,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

describe("MemoryConsolidation — summarizeAgentSteps", () => {
  test("空 steps → 空 text", () => {
    const r = summarizeAgentSteps([], "research");
    expect(r.text).toContain("0 步");
    expect(r.toolsUsed).toEqual({});
  });

  test("统计 tool_call 次数", () => {
    const steps = [
      mkStep({ stepIndex: 0, actionType: "tool_call", actionJson: { tool: "factor.list" } }),
      mkStep({ stepIndex: 1, actionType: "tool_call", actionJson: { tool: "factor.list" } }),
      mkStep({ stepIndex: 2, actionType: "tool_call", actionJson: { tool: "code.run_python" } }),
    ];
    const r = summarizeAgentSteps(steps, "research");
    expect(r.toolsUsed).toEqual({ "factor.list": 2, "code.run_python": 1 });
    expect(r.text).toContain("factor.list×2");
    expect(r.text).toContain("code.run_python×1");
  });

  test("提取 final_answer", () => {
    const steps = [
      mkStep({
        stepIndex: 5,
        actionType: "final_answer",
        actionJson: { answer: "最佳因子为 momentum_20d，RankIC=0.045，IR=0.82" },
      }),
    ];
    const r = summarizeAgentSteps(steps, "research");
    expect(r.finalAnswer).toBe("最佳因子为 momentum_20d，RankIC=0.045，IR=0.82");
    expect(r.text).toContain("RankIC=0.045");
  });

  test("最多保留 3 段 thought 作为推理线索", () => {
    const steps = [
      mkStep({ thought: "step1 thought 关键发现 A" }),
      mkStep({ thought: "step2 thought 关键发现 B" }),
      mkStep({ thought: "step3 thought 关键发现 C" }),
      mkStep({ thought: "step4 should be skipped" }),
    ];
    const r = summarizeAgentSteps(steps, "analyst_fundamental");
    expect(r.text).toContain("关键发现 A");
    expect(r.text).toContain("关键发现 B");
    expect(r.text).toContain("关键发现 C");
    expect(r.text).not.toContain("should be skipped");
  });

  test("超长 thought 截断到 400 字", () => {
    const longThought = "a".repeat(800);
    const steps = [mkStep({ thought: longThought })];
    const r = summarizeAgentSteps(steps, "research");
    expect(r.text.length).toBeLessThan(800);
  });
});

describe("MemoryConsolidation — inferMemoryType", () => {
  const emptySummary = { text: "", finalAnswer: "", toolsUsed: {} };

  test("risk → risk_review", () => {
    expect(inferMemoryType("risk", emptySummary)).toBe("risk_review");
    expect(inferMemoryType("risk_manager", emptySummary)).toBe("risk_review");
  });

  test("backtest / walk_forward / validator → simulation_note", () => {
    expect(inferMemoryType("backtest", emptySummary)).toBe("simulation_note");
    expect(inferMemoryType("backtest_engineer", emptySummary)).toBe("simulation_note");
    expect(inferMemoryType("walk_forward_validator", emptySummary)).toBe("simulation_note");
  });

  test("research / orchestrator → strategy_iteration", () => {
    expect(inferMemoryType("research", emptySummary)).toBe("strategy_iteration");
    expect(inferMemoryType("orchestrator", emptySummary)).toBe("strategy_iteration");
  });

  test("其它（analyst / news / market_data）→ strategy_iteration（兜底）", () => {
    expect(inferMemoryType("analyst_fundamental", emptySummary)).toBe("strategy_iteration");
    expect(inferMemoryType("analyst_technical", emptySummary)).toBe("strategy_iteration");
    expect(inferMemoryType("news_event", emptySummary)).toBe("strategy_iteration");
    expect(inferMemoryType("market_data", emptySummary)).toBe("strategy_iteration");
  });
});
