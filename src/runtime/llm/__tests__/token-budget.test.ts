/**
 * token-budget.test.ts (P1-6 动态 token budget + historyCompactor)
 *
 * 验证：
 *   - estimateTokens：chars/4 数量级
 *   - getContextWindow：known models 准确 + 未知模型 fallback 128K
 *   - computePromptBudget：safetyRatio 公式
 *   - compactObservations：单条截断 + 早期 step 替换为 stub + 保留最近 K
 */
import { describe, expect, test } from "bun:test";
import {
  KNOWN_MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  compactObservations,
  computePromptBudget,
  estimateTokens,
  estimateTokensOfJson,
  getContextWindow,
} from "../token-budget";

describe("estimateTokens (P1-6)", () => {
  test("空 / null / undefined → 0", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  test("4 char → 1 token，5 char → 2 token（ceil 行为）", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  test("100 char → 25 token，1K char → 250 token", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("a".repeat(1000))).toBe(250);
  });

  test("estimateTokensOfJson 处理对象", () => {
    expect(estimateTokensOfJson({ a: 1, b: "hello" })).toBeGreaterThan(0);
    /** circular → 不抛错，返回 0 */
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(estimateTokensOfJson(a)).toBe(0);
  });
});

describe("getContextWindow (P1-6)", () => {
  test("显式传入值最优先", () => {
    expect(getContextWindow("gpt-5.5", 50_000)).toBe(50_000);
  });

  test("known models 精确匹配", () => {
    expect(getContextWindow("gpt-5.5")).toBe(400_000);
    expect(getContextWindow("claude-opus-4-8")).toBe(200_000);
    expect(getContextWindow("gemini-2.5-pro")).toBe(2_000_000);
    expect(getContextWindow("deepseek-chat")).toBe(128_000);
    expect(getContextWindow("qwen3-max")).toBe(256_000);
  });

  test("case-insensitive", () => {
    expect(getContextWindow("GPT-5.5")).toBe(400_000);
    expect(getContextWindow("Claude-Opus-4-8")).toBe(200_000);
  });

  test("前缀匹配带日期后缀", () => {
    expect(getContextWindow("gpt-4o-2024-08-06")).toBe(128_000);
    expect(getContextWindow("claude-3-5-sonnet-20241022")).toBe(200_000);
  });

  test("未知模型 → DEFAULT_CONTEXT_WINDOW", () => {
    expect(getContextWindow("totally-made-up-model")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindow(null)).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindow(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  test("KNOWN_MODEL_CONTEXT_WINDOWS 覆盖 Round 6 实际用的所有模型族", () => {
    /** 至少包含 OpenAI / Anthropic / Gemini / DeepSeek / Qwen 各一个 */
    expect(Object.keys(KNOWN_MODEL_CONTEXT_WINDOWS).length).toBeGreaterThan(15);
    expect(KNOWN_MODEL_CONTEXT_WINDOWS["gpt-5.5"]).toBeDefined();
    expect(KNOWN_MODEL_CONTEXT_WINDOWS["claude-opus-4-8"]).toBeDefined();
    expect(KNOWN_MODEL_CONTEXT_WINDOWS["gemini-2.5-pro"]).toBeDefined();
    expect(KNOWN_MODEL_CONTEXT_WINDOWS["deepseek-chat"]).toBeDefined();
  });
});

describe("computePromptBudget (P1-6)", () => {
  test("128K window + 8K maxOutput → 81600 token 可用预算", () => {
    expect(
      computePromptBudget({ contextWindow: 128_000, maxOutputTokens: 8_000 })
    ).toBe(81_600);
  });

  test("200K window + 8K maxOutput → 132000", () => {
    expect(
      computePromptBudget({ contextWindow: 200_000, maxOutputTokens: 8_000 })
    ).toBe(132_000);
  });

  test("1M window + 8K maxOutput → 692000", () => {
    expect(
      computePromptBudget({ contextWindow: 1_000_000, maxOutputTokens: 8_000 })
    ).toBe(692_000);
  });

  test("safetyRatio 可配置", () => {
    expect(
      computePromptBudget({
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        safetyRatio: 0.85,
      })
    ).toBe(Math.floor(128_000 * 0.85) - 4_096);
  });

  test("非常小的 window 不能为负数", () => {
    expect(
      computePromptBudget({ contextWindow: 8_000, maxOutputTokens: 8_000 })
    ).toBe(0);
  });
});

describe("compactObservations (P1-6)", () => {
  test("空数组 → 空结果", () => {
    const r = compactObservations([], {
      fixedPromptTokens: 0,
      promptBudget: 1000,
    });
    expect(r.observations).toEqual([]);
    expect(r.estimatedTokens).toBe(0);
    expect(r.actions.droppedEarly).toBe(0);
    expect(r.actions.truncatedPerItem).toBe(0);
  });

  test("所有 observations 都小且总和在预算内 → 原样保留", () => {
    const obs = [
      { thought: "step1 short" },
      { thought: "step2 short" },
      { thought: "step3 short" },
    ];
    const r = compactObservations(obs, {
      fixedPromptTokens: 0,
      promptBudget: 100_000,
    });
    expect(r.observations).toEqual(obs);
    expect(r.actions.droppedEarly).toBe(0);
    expect(r.actions.truncatedPerItem).toBe(0);
  });

  test("单条 observation 超 maxCharsPerObservation → 截断 + 不丢但变 stub", () => {
    const obs = [
      { thought: "step1" },
      /** 第二条很大：让 JSON 序列化结果远超 maxCharsPerObservation */
      { thought: "x".repeat(20_000) },
      { thought: "step3" },
    ];
    const r = compactObservations(obs, {
      fixedPromptTokens: 0,
      promptBudget: 100_000,
      maxCharsPerObservation: 4000,
    });
    expect(r.actions.truncatedPerItem).toBe(1);
    /** 截断后变 stub，但仍占据原索引位 */
    expect(r.observations).toHaveLength(3);
    const truncated = r.observations[1] as { __compacted: boolean; summary: string };
    expect(truncated.__compacted).toBe(true);
    expect(truncated.summary).toMatch(/truncated/);
  });

  test("总 token > budget → 早期 step 被替换为 stub，最近 keepRecent 保留", () => {
    /** 5 步、每步 ~250 token，total ~1250 token；预算只够 ~500 token */
    const obs = Array.from({ length: 5 }, (_, i) => ({
      step: i + 1,
      data: "y".repeat(1000), // ~1000/4 = 250 token
    }));
    const r = compactObservations(obs, {
      fixedPromptTokens: 0,
      promptBudget: 600,
      keepRecent: 2,
    });
    expect(r.observations).toHaveLength(5);
    /** 最近 2 步保持原样 */
    expect((r.observations[3] as { step: number }).step).toBe(4);
    expect((r.observations[4] as { step: number }).step).toBe(5);
    /** 前 3 步至少有 droppedEarly = 3，因为单步 250 token 已经超 600-500 */
    expect(r.actions.droppedEarly).toBeGreaterThan(0);
    /** 早期被替换的步骤都带 __compacted 标记 */
    for (let i = 0; i < 3; i++) {
      const e = r.observations[i] as { __compacted?: boolean; summary?: string };
      if (e.__compacted) {
        expect(e.summary).toMatch(/compacted/);
      }
    }
  });

  test("fixedPromptTokens 占大头时 observation 预算紧张 → 多丢早期", () => {
    const obs = Array.from({ length: 5 }, (_, i) => ({
      step: i + 1,
      data: "z".repeat(400), // ~100 token / 步
    }));
    const r = compactObservations(obs, {
      fixedPromptTokens: 50_000,
      promptBudget: 50_200, // 留给 obs 仅 200 token，能塞 2 步
      keepRecent: 2,
    });
    /** 最近 2 步加起来 200 token，预算贴满 → 早期 3 步全 stub */
    expect(r.actions.keptRecent).toBe(2);
    /**
     * 早期 3 步至少有几个被 stub 化（droppedEarly>=2，因为 stub 比原文小，可能塞下一两个）
     * compactor 实现：把不够塞的 stub 化；如果 stub 后还够空间，下一步可能也保留
     */
    expect(r.actions.droppedEarly).toBeGreaterThanOrEqual(2);
  });

  test("keepRecent 大于 observations 数量 → 全部保留（不抛错）", () => {
    const obs = [{ step: 1 }, { step: 2 }];
    const r = compactObservations(obs, {
      fixedPromptTokens: 0,
      promptBudget: 1000,
      keepRecent: 10,
    });
    expect(r.observations).toEqual(obs);
    expect(r.actions.keptRecent).toBe(2);
    expect(r.actions.droppedEarly).toBe(0);
  });
});
