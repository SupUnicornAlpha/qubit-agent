/**
 * P1：LLM cost 估算回归测试。
 *
 * 覆盖：
 *   - 精确价表命中：gpt-4o / claude-3-5-sonnet / deepseek-chat
 *   - provider fallback（model 未列在价表）
 *   - 未知 provider（ollama / mock）→ 0
 *   - 负数 / 0 token 兜底
 *   - 精度（6 位小数）
 */
import { describe, expect, test } from "bun:test";
import { estimateLlmCostUsd } from "../llm-pricing";

describe("estimateLlmCostUsd · 精确价表", () => {
  test("gpt-4o：prompt $2.5 / completion $10 per 1M", () => {
    const cost = estimateLlmCostUsd({
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost).toBe(12.5);
  });

  test("claude-3-5-sonnet：$3 + $15 per 1M", () => {
    const cost = estimateLlmCostUsd({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost).toBe(18);
  });

  test("deepseek-chat：$0.27 + $1.10 per 1M", () => {
    const cost = estimateLlmCostUsd({
      provider: "deepseek",
      model: "deepseek-chat",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost).toBe(1.37);
  });
});

describe("estimateLlmCostUsd · provider fallback / 未知 / 边界", () => {
  test("openai 内未在价表的 model 用 provider 默认价", () => {
    const cost = estimateLlmCostUsd({
      provider: "openai",
      model: "gpt-4o-preview-2099",
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    expect(cost).toBe(2.5);
  });

  test("ollama / mock 等本地推理返回 0", () => {
    expect(
      estimateLlmCostUsd({
        provider: "ollama",
        model: "llama3",
        promptTokens: 999_999,
        completionTokens: 999_999,
      })
    ).toBe(0);
    expect(
      estimateLlmCostUsd({
        provider: "mock",
        model: "mock",
        promptTokens: 100,
        completionTokens: 100,
      })
    ).toBe(0);
  });

  test("0 / 负数 token 都视为 0 token，不抛错", () => {
    expect(
      estimateLlmCostUsd({
        provider: "openai",
        model: "gpt-4o",
        promptTokens: 0,
        completionTokens: 0,
      })
    ).toBe(0);
    expect(
      estimateLlmCostUsd({
        provider: "openai",
        model: "gpt-4o",
        promptTokens: -100,
        completionTokens: -100,
      })
    ).toBe(0);
  });

  test("结果保留 6 位小数：1k token 量级也不会被吞", () => {
    const cost = estimateLlmCostUsd({
      provider: "openai",
      model: "gpt-4o-mini",
      promptTokens: 1000,
      completionTokens: 1000,
    });
    // 1000 * 0.15/1M + 1000 * 0.6/1M = 0.00015 + 0.0006 = 0.00075
    expect(cost).toBe(0.00075);
  });
});

describe("estimateLlmCostUsd · P2 cached input 折扣", () => {
  test("OpenAI cached prompt 享 50% 折扣，老 caller 不传 cachedPromptTokens 等价老行为", () => {
    /** 老行为：1M prompt × $2.5 = $2.5 */
    const baseline = estimateLlmCostUsd({
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    expect(baseline).toBe(2.5);

    /** 全部 cached：1M × $2.5 × 0.5 = $1.25 */
    const allCached = estimateLlmCostUsd({
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
    });
    expect(allCached).toBe(1.25);

    /** 半 cached：500k uncached × $2.5/1M + 500k cached × $1.25/1M = $1.875 */
    const halfCached = estimateLlmCostUsd({
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 500_000,
    });
    expect(halfCached).toBe(1.875);
  });

  test("Anthropic cached prompt 享 10% 折扣（cache_read 价 = uncached × 10%）", () => {
    /** 1M cached × $3 × 0.1 = $0.3 */
    const allCached = estimateLlmCostUsd({
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 1_000_000,
    });
    expect(allCached).toBe(0.3);
  });

  test("cachedPromptTokens > promptTokens 被 clamp 到 promptTokens", () => {
    /** 上游打点 bug：cached > total。我们 clamp 而不是抛错。 */
    const cost = estimateLlmCostUsd({
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 100_000,
      completionTokens: 0,
      cachedPromptTokens: 999_999_999,
    });
    /** 100k × $2.5 × 0.5 = $0.125 */
    expect(cost).toBe(0.125);
  });

  test("负数 cachedPromptTokens 视为 0", () => {
    const cost = estimateLlmCostUsd({
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: -123,
    });
    expect(cost).toBe(2.5);
  });

  test("DeepSeek 没有 cache 折扣表 → cachedPromptTokens 不影响结果", () => {
    const a = estimateLlmCostUsd({
      provider: "deepseek",
      model: "deepseek-chat",
      promptTokens: 1_000_000,
      completionTokens: 0,
    });
    const b = estimateLlmCostUsd({
      provider: "deepseek",
      model: "deepseek-chat",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedPromptTokens: 500_000,
    });
    expect(a).toBe(b);
  });
});

describe("estimateLlmCostUsd · P2 价表升级", () => {
  test("gpt-5 / gpt-5-mini / gpt-5-nano 命中精确单价", () => {
    expect(
      estimateLlmCostUsd({ provider: "openai", model: "gpt-5", promptTokens: 1_000_000, completionTokens: 0 }),
    ).toBe(1.25);
    expect(
      estimateLlmCostUsd({ provider: "openai", model: "gpt-5-mini", promptTokens: 0, completionTokens: 1_000_000 }),
    ).toBe(2);
    expect(
      estimateLlmCostUsd({ provider: "openai", model: "gpt-5-nano", promptTokens: 0, completionTokens: 1_000_000 }),
    ).toBe(0.4);
  });

  test("deepseek-r1 命中精确单价（与 reasoner 同价）", () => {
    expect(
      estimateLlmCostUsd({
        provider: "deepseek",
        model: "deepseek-r1",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
      }),
    ).toBe(2.74);
  });

  test("claude-3-5-sonnet-v2 命中（与 -latest 同价 + 10% cache 折扣）", () => {
    expect(
      estimateLlmCostUsd({
        provider: "anthropic",
        model: "claude-3-5-sonnet-v2",
        promptTokens: 1_000_000,
        completionTokens: 0,
        cachedPromptTokens: 1_000_000,
      }),
    ).toBe(0.3);
  });
});
