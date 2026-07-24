import { describe, expect, test } from "bun:test";
import { parseLoopOptionsJson } from "../loop";

describe("parseLoopOptionsJson", () => {
  test("保留工作流迭代与 token 预算覆盖", () => {
    const parsed = parseLoopOptionsJson({
      maxIterations: 7,
      tokenBudget: {
        maxTotalTokens: 120_000,
        maxPromptTokensPerCall: 12_000,
        maxSystemPromptChars: 16_000,
        maxUserPromptChars: 20_000,
        softLimitRatio: 0.75,
      },
      unknownField: "removed",
    });

    expect(parsed.maxIterations).toBe(7);
    expect(parsed.tokenBudget).toEqual({
      maxTotalTokens: 120_000,
      maxPromptTokensPerCall: 12_000,
      maxSystemPromptChars: 16_000,
      maxUserPromptChars: 20_000,
      softLimitRatio: 0.75,
    });
    expect("unknownField" in parsed).toBe(false);
  });

  test("拒绝无效预算并回退为空配置", () => {
    expect(
      parseLoopOptionsJson({
        maxIterations: 0,
        tokenBudget: { maxTotalTokens: -1 },
      })
    ).toEqual({});
  });
});
