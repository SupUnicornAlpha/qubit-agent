import { describe, expect, test } from "bun:test";
import { resolveWorkflowTokenBudget } from "../workflow-token-budget";

describe("resolveWorkflowTokenBudget", () => {
  test("chat 默认预算低于完整 research workflow", () => {
    const chat = resolveWorkflowTokenBudget(undefined, {
      source: "chat",
      mode: "research",
      researchScenarioId: null,
    });
    const research = resolveWorkflowTokenBudget(undefined, {
      source: "manual",
      mode: "research",
      researchScenarioId: "factor_research",
    });
    expect(chat.maxTotalTokens).toBe(100_000);
    expect(research.maxTotalTokens).toBe(300_000);
  });

  test("workflow override 覆盖默认值", () => {
    const policy = resolveWorkflowTokenBudget(
      {
        maxTotalTokens: 50_000,
        softLimitRatio: 0.7,
        maxPromptTokensPerCall: 9_000,
      },
      { source: "chat", mode: "research", researchScenarioId: null }
    );
    expect(policy.maxTotalTokens).toBe(50_000);
    expect(policy.softLimitRatio).toBe(0.7);
    expect(policy.maxPromptTokensPerCall).toBe(9_000);
    expect(policy.maxSystemPromptChars).toBeGreaterThan(0);
  });
});
