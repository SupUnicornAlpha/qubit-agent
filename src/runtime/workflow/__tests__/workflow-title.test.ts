import { describe, expect, test } from "bun:test";
import { isResearchTeamPlaceholderTitle, summarizeResearchQuestionTitle } from "../workflow-title";

describe("research workflow title", () => {
  test("replaces legacy scope-and-timestamp placeholders only", () => {
    expect(isResearchTeamPlaceholderTitle("研究团队 · 单标的 · 标的 · 2026/8/19 19:36")).toBe(true);
    expect(isResearchTeamPlaceholderTitle("研究团队 · 板块 · 半导体 · 2026/8/19")).toBe(true);
    expect(isResearchTeamPlaceholderTitle("研究团队 · 分析 AAPL 财报后的交易机会")).toBe(false);
  });

  test("summarizes a user question into a stable, classified title", () => {
    expect(
      summarizeResearchQuestionTitle("请帮我分析 AAPL 财报后的交易机会，以及需要关注的风险。")
    ).toBe("研究团队 · 分析 AAPL 财报后的交易机会，以及需要关注的风险");
  });

  test("keeps the side-bar title bounded for detailed requests", () => {
    const title = summarizeResearchQuestionTitle(
      "请你评估英伟达未来十二个月的增长驱动、估值风险、竞争格局、期权隐含波动率与仓位管理建议，并给出可执行方案"
    );
    expect(Array.from(title).length).toBeLessThanOrEqual(49);
    expect(title.endsWith("…")).toBe(true);
  });
});
