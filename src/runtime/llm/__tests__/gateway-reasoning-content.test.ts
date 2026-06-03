/**
 * P2-2：DeepSeek-R1 reasoning_content → reasoningTokens 估算单测。
 *
 * runOpenAICompatible 主流程依赖 OpenAI SDK 实例（mock 成本高），所以这里只覆盖
 * **纯函数**层 estimateReasoningTokensFromChars，集成路径留给运行时回归。
 *
 * 估算逻辑：
 *   - 0 / 负数 / NaN → 0（不写 reasoningTokens 字段）
 *   - 任意正字符数 → ceil(chars / 4)
 */

import { describe, expect, test } from "bun:test";
import { estimateReasoningTokensFromChars } from "../gateway";

describe("estimateReasoningTokensFromChars", () => {
  test("0 / 负数 / NaN → 0", () => {
    expect(estimateReasoningTokensFromChars(0)).toBe(0);
    expect(estimateReasoningTokensFromChars(-100)).toBe(0);
    expect(estimateReasoningTokensFromChars(Number.NaN)).toBe(0);
    expect(estimateReasoningTokensFromChars(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("常规正数 → ceil(chars / 4)", () => {
    expect(estimateReasoningTokensFromChars(1)).toBe(1);
    expect(estimateReasoningTokensFromChars(3)).toBe(1);
    expect(estimateReasoningTokensFromChars(4)).toBe(1);
    expect(estimateReasoningTokensFromChars(5)).toBe(2);
    expect(estimateReasoningTokensFromChars(7)).toBe(2);
    expect(estimateReasoningTokensFromChars(8)).toBe(2);
    expect(estimateReasoningTokensFromChars(100)).toBe(25);
  });

  test("DeepSeek-R1 典型 reasoning 输出量级（10k chars 推理）", () => {
    /** ~10k chars of CoT → 估算约 2500 token */
    expect(estimateReasoningTokensFromChars(10_000)).toBe(2500);
  });
});
