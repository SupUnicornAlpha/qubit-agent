import { describe, expect, test } from "bun:test";
import { buildFocusedResearchScenarioPrompt } from "./reason";

describe("buildFocusedResearchScenarioPrompt", () => {
  test("factor research forbids generic team completion without artifacts", () => {
    const prompt = buildFocusedResearchScenarioPrompt("factor_research");
    expect(prompt).toContain("不得自动扩成通用研究团队");
    expect(prompt).toContain("factor.register");
    expect(prompt).toContain("没有真实入库因子时");
  });

  test("stock screening requires executable recommendation fields", () => {
    const prompt = buildFocusedResearchScenarioPrompt("stock_screening");
    expect(prompt).toContain("recommendation");
    expect(prompt).toContain("止盈");
    expect(prompt).toContain("止损");
  });

  test("unconstrained scenarios remain unchanged", () => {
    expect(buildFocusedResearchScenarioPrompt("analyst_debate")).toBe("");
    expect(buildFocusedResearchScenarioPrompt(null)).toBe("");
  });
});
