import { describe, expect, test } from "bun:test";
import { resolveRolePromptBudget } from "../../llm/token-budget";
import { formatReasonClockContext } from "../nodes/reason";

describe("reason clock + role budgets", () => {
  test("clock context includes as-of dates", () => {
    const text = formatReasonClockContext(new Date("2026-08-03T13:00:00.000Z"));
    expect(text).toContain("2026-08-03");
    expect(text).toContain("Asia/Shanghai");
    expect(text).toContain("startDate");
  });

  test("market_data uses a tighter prompt budget than orchestrator", () => {
    const md = resolveRolePromptBudget("market_data");
    const orch = resolveRolePromptBudget("orchestrator");
    expect(md.maxPromptTokens).toBeLessThan(orch.maxPromptTokens);
    expect(md.maxCharsPerObservation).toBeLessThanOrEqual(orch.maxCharsPerObservation);
  });

  test("agent overrides win", () => {
    const budget = resolveRolePromptBudget("market_data", { maxPromptTokens: 9000 });
    expect(budget.maxPromptTokens).toBe(9000);
  });
});
