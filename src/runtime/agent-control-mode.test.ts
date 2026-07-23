import { describe, expect, test } from "bun:test";
import { resolveAgentControlMode } from "../types/loop";
import {
  assessGoalPlanCompletion,
  buildAgentControlModePrompt,
  isToolAllowedInAgentControlMode,
  parseAgentPlanSnapshot,
} from "./agent-control-mode";

describe("resolveAgentControlMode", () => {
  test("defaults to agent and accepts all canonical modes", () => {
    expect(resolveAgentControlMode(undefined)).toBe("agent");
    expect(resolveAgentControlMode({ agentMode: "agent" })).toBe("agent");
    expect(resolveAgentControlMode({ agentMode: "plan" })).toBe("plan");
    expect(resolveAgentControlMode({ agentMode: "goal" })).toBe("goal");
  });

  test("maps legacy coding_agent to goal while canonical field wins", () => {
    expect(resolveAgentControlMode({ experience: "native" })).toBe("agent");
    expect(resolveAgentControlMode({ experience: "coding_agent" })).toBe("goal");
    expect(resolveAgentControlMode({ agentMode: "plan", experience: "coding_agent" })).toBe("plan");
  });
});

describe("Plan mode execution boundary", () => {
  test("only update_plan is executable", () => {
    expect(isToolAllowedInAgentControlMode("plan", "update_plan")).toBe(true);
    expect(isToolAllowedInAgentControlMode("plan", "fetch_klines")).toBe(false);
    expect(isToolAllowedInAgentControlMode("plan", "assign_task")).toBe(false);
    expect(isToolAllowedInAgentControlMode("agent", "fetch_klines")).toBe(true);
    expect(isToolAllowedInAgentControlMode("goal", "assign_task")).toBe(true);
  });

  test("prompt explicitly forbids execution and requires a persisted plan", () => {
    const prompt = buildAgentControlModePrompt("plan", true);
    expect(prompt).toContain("不得实际查询行情");
    expect(prompt).toContain("必须调用一次 `update_plan`");
  });
});

describe("Goal completion gate", () => {
  test("rejects a missing or unfinished plan", () => {
    expect(assessGoalPlanCompletion(null).code).toBe("missing_plan");
    const result = assessGoalPlanCompletion({
      steps: [
        { id: "s1", title: "取数", status: "done" },
        { id: "s2", title: "验证", status: "in_progress" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("unfinished_steps");
    expect(result.pendingStepIds).toEqual(["s2"]);
  });

  test("accepts only terminal done/skipped steps", () => {
    const result = assessGoalPlanCompletion({
      mode: "goal",
      steps: [
        { id: "s1", title: "取数", status: "done" },
        { id: "s2", title: "不可用数据源", status: "skipped", note: "熔断" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe("complete");
  });

  test("normalizes malformed plan entries defensively", () => {
    expect(
      parseAgentPlanSnapshot({
        mode: "goal",
        steps: [{ title: "有效步骤", status: "unknown" }, { title: "", status: "done" }, null],
      })
    ).toEqual({
      mode: "goal",
      steps: [{ id: "s1", title: "有效步骤", status: "pending" }],
    });
  });
});
