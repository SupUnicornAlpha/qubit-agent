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
