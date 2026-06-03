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

describe("estimateLlmCostUsd · P3-1 cache write 加价（Anthropic 1.25×）", () => {
  test("Anthropic cache_creation_input_tokens 按 inUsdPerM × 1.25 计费", () => {
    /** claude-3-5-sonnet-20241022：$3 / 1M input；写 cache 应为 $3.75 / 1M */
    const cost = estimateLlmCostUsd({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(cost).toBe(3.75);
  });

  test("read + write 同时存在：read 0.1× / write 1.25× / 剩余 1.0× 各自独立计费", () => {
    /**
     * 1M prompt 拆三段（claude-3-5-sonnet @ $3/1M input）：
     *   - 800k 写 cache：800k × 3 × 1.25 / 1M = $3.00
     *   - 150k 读 cache：150k × 3 × 0.10 / 1M = $0.045
     *   - 50k 普通 input：50k × 3 × 1.00 / 1M = $0.15
     *   合计 $3.195
     */
    const cost = estimateLlmCostUsd({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheCreationInputTokens: 800_000,
      cachedPromptTokens: 150_000,
    });
    expect(cost).toBeCloseTo(3.195, 6);
  });

  test("OpenAI 不应用 cache write 加价（保持 1.0×，因为 OpenAI Responses 没这个概念）", () => {
    /** gpt-4o：$2.5 / 1M input；写 cache 应仍是 $2.5 / 1M（不像 Anthropic 加价） */
    const cost = estimateLlmCostUsd({
      provider: "openai",
      model: "gpt-4o",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(cost).toBe(2.5);
  });

  test("cache_creation_input_tokens > prompt 被 clamp（防上游打点错乱）", () => {
    const cost = estimateLlmCostUsd({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1000,
      completionTokens: 0,
      cacheCreationInputTokens: 999_999, // 远超 promptTokens
    });
    /** 应按 1000 token 计：1000 × $3 / 1M × 1.25 = $0.00375 */
    expect(cost).toBeCloseTo(0.00375, 8);
  });

  test("cache write 与 cache read 总和不超过 prompt（write 优先占额）", () => {
    /**
     * write=600k, read=600k, prompt=1M → write 取 600k，read 在剩余 400k 里 clamp 为 400k
     * cost = 600k × 3 × 1.25 / 1M + 400k × 3 × 0.1 / 1M = 2.25 + 0.12 = 2.37
     */
    const cost = estimateLlmCostUsd({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      promptTokens: 1_000_000,
      completionTokens: 0,
      cacheCreationInputTokens: 600_000,
      cachedPromptTokens: 600_000, // 表面上 write+read=1.2M > prompt
    });
    expect(cost).toBeCloseTo(2.37, 6);
  });
});
