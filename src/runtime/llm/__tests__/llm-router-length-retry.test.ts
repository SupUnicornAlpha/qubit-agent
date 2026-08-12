/**
 * P2-3：invokeWithFallback 自动 length-retry 单测。
 *
 * 覆盖：
 *   1) finishReason='length' → max_tokens × 2 重试，answer 取拼接结果，
 *      lengthRetryUsed=true，usage 累加。
 *   2) finishReason='max_output_tokens' / 'incomplete' 同样触发重试。
 *   3) finishReason='stop' / 'content_filter' / 'tool_calls' → 不重试。
 *   4) sampling.maxOutputTokens 已经 ≥ 32768（cap）→ 不重试。
 *   5) ENV QUBIT_LLM_LENGTH_RETRY_DISABLED=1 → 完全关闭。
 *   6) length retry 自身抛错 → 保留首次截断结果（不连带原结果丢失）。
 *
 * mock 策略：直接 spyOn `runLlmGateway` 模块导出，避免拉真实 fetch / OpenAI SDK。
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as gatewayModule from "../gateway";
import { invokeWithFallback } from "../llm-router";

type GatewayResult = Awaited<ReturnType<typeof gatewayModule.runLlmGateway>>;

function ok(answer: string, finishReason?: string, extras?: Partial<GatewayResult>): GatewayResult {
  return {
    answer,
    latencyMs: 100,
    ...(finishReason ? { finishReason } : {}),
    ...extras,
  } as GatewayResult;
}

const MOCK_CONFIG = {
  provider: "mock" as const,
  model: "mock-test",
  apiKey: "",
};

describe("invokeWithFallback · P2 length-retry", () => {
  let runSpy: ReturnType<typeof spyOn<typeof gatewayModule, "runLlmGateway">>;
  const origDisabled = process.env.QUBIT_LLM_LENGTH_RETRY_DISABLED;

  beforeEach(() => {
    runSpy = spyOn(gatewayModule, "runLlmGateway");
    delete process.env.QUBIT_LLM_LENGTH_RETRY_DISABLED;
  });

  afterEach(() => {
    runSpy.mockRestore();
    if (origDisabled === undefined) delete process.env.QUBIT_LLM_LENGTH_RETRY_DISABLED;
    else process.env.QUBIT_LLM_LENGTH_RETRY_DISABLED = origDisabled;
  });

  test("finishReason='length' → 自动加大 maxOutputTokens 重试一次", async () => {
    const calls: Array<{ maxOutputTokens?: number }> = [];
    runSpy.mockImplementation(((input: gatewayModule.LlmGatewayInput) => {
      const m = input.sampling?.maxOutputTokens;
      calls.push(m !== undefined ? { maxOutputTokens: m } : {});
      if (calls.length === 1) {
        return Promise.resolve(
          ok("part 1...", "length", { usage: { promptTokens: 100, completionTokens: 4096 } })
        );
      }
      return Promise.resolve(
        ok("part 1...part 2 done", "stop", {
          usage: { promptTokens: 100, completionTokens: 200 },
        })
      );
    }) as typeof gatewayModule.runLlmGateway);

    const result = await invokeWithFallback(MOCK_CONFIG, {
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
      sampling: { maxOutputTokens: 4096 },
    });

    expect(calls.length).toBe(2);
    expect(calls[0]?.maxOutputTokens).toBe(4096);
    /** 翻倍但不超过 cap */
    expect(calls[1]?.maxOutputTokens).toBe(8192);
    expect(result.lengthRetryUsed).toBe(true);
    expect(result.finishReason).toBe("stop");
    expect(result.answer).toBe("part 1...part 2 done");
    /** usage 累加：promptTokens 100+100；completionTokens 4096+200 */
    expect(result.usage?.promptTokens).toBe(200);
    expect(result.usage?.completionTokens).toBe(4296);
    /** latencyMs 累加 */
    expect(result.latencyMs).toBe(200);
  });

  test("finishReason='max_output_tokens' / 'incomplete' 同样触发", async () => {
    for (const fr of ["max_output_tokens", "incomplete"]) {
      runSpy.mockReset();
      let n = 0;
      runSpy.mockImplementation(() => {
        n += 1;
        return Promise.resolve(n === 1 ? ok("a", fr) : ok("ab", "stop"));
      });
      const r = await invokeWithFallback(MOCK_CONFIG, {
        systemPrompt: "s",
        userPrompt: "u",
        onToken: () => {},
      });
      expect(r.lengthRetryUsed).toBe(true);
      expect(n).toBe(2);
    }
  });

  test("finishReason='stop' / 'content_filter' / 'tool_calls' → 不重试", async () => {
    for (const fr of ["stop", "content_filter", "tool_calls", undefined]) {
      runSpy.mockReset();
      let n = 0;
      runSpy.mockImplementation(() => {
        n += 1;
        return Promise.resolve(ok("ok", fr));
      });
      const r = await invokeWithFallback(MOCK_CONFIG, {
        systemPrompt: "s",
        userPrompt: "u",
        onToken: () => {},
      });
      expect(r.lengthRetryUsed).toBe(false);
      expect(n).toBe(1);
    }
  });

  test("已经达到 32768 cap 的 sampling.maxOutputTokens 不再重试", async () => {
    let n = 0;
    runSpy.mockImplementation(() => {
      n += 1;
      return Promise.resolve(ok("trunc", "length"));
    });
    const r = await invokeWithFallback(MOCK_CONFIG, {
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
      sampling: { maxOutputTokens: 32_768 },
    });
    expect(n).toBe(1);
    expect(r.lengthRetryUsed).toBe(false);
    expect(r.finishReason).toBe("length");
  });

  test("ENV QUBIT_LLM_LENGTH_RETRY_DISABLED=1 → 完全关闭", async () => {
    process.env.QUBIT_LLM_LENGTH_RETRY_DISABLED = "1";
    let n = 0;
    runSpy.mockImplementation(() => {
      n += 1;
      return Promise.resolve(ok("trunc", "length"));
    });
    const r = await invokeWithFallback(MOCK_CONFIG, {
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });
    expect(n).toBe(1);
    expect(r.lengthRetryUsed).toBe(false);
  });

  test("length retry 自身抛错 → 保留首次截断结果（不连带丢失）", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    runSpy.mockImplementation(() => {
      n += 1;
      if (n === 1) return Promise.resolve(ok("partial", "length"));
      throw new Error("retry boom");
    });
    const r = await invokeWithFallback(MOCK_CONFIG, {
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });
    expect(n).toBe(2);
    expect(r.answer).toBe("partial");
    expect(r.finishReason).toBe("length");
    expect(r.lengthRetryUsed).toBe(false);
    warnSpy.mockRestore();
  });

  test("retry 翻倍，但不会一次跳过 cap（4096 → 8192 → 16384 → 32768 这种）", async () => {
    /**
     * 单次只翻倍一次。模拟 sampling.maxOutputTokens=20000 截断 → 重试 40000 ↑
     * cap=32768，所以应取 min(40000, 32768)=32768。
     */
    const calls: Array<{ maxOutputTokens?: number }> = [];
    runSpy.mockImplementation(((input: gatewayModule.LlmGatewayInput) => {
      const m = input.sampling?.maxOutputTokens;
      calls.push(m !== undefined ? { maxOutputTokens: m } : {});
      return Promise.resolve(calls.length === 1 ? ok("a", "length") : ok("ab", "stop"));
    }) as typeof gatewayModule.runLlmGateway);
    await invokeWithFallback(MOCK_CONFIG, {
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
      sampling: { maxOutputTokens: 20_000 },
    });
    expect(calls[1]?.maxOutputTokens).toBe(32_768);
  });

  test("socket reset 会在同一 provider 上重试，而不是直接交给 reason 节点收口", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    runSpy.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(
          new Error(
            "The socket connection was closed unexpectedly. For more information, pass verbose"
          )
        );
      }
      return Promise.resolve(ok("recovered", "stop"));
    });

    const result = await invokeWithFallback(MOCK_CONFIG, {
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });

    expect(calls).toBe(2);
    expect(result.answer).toBe("recovered");
    warnSpy.mockRestore();
  });

  test("provider 503 忙碌会被视作瞬时故障并重试", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    runSpy.mockImplementation(() => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("503 Service is too busy"));
      return Promise.resolve(ok("recovered after 503", "stop"));
    });

    const result = await invokeWithFallback(MOCK_CONFIG, {
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });

    expect(calls).toBe(2);
    expect(result.answer).toBe("recovered after 503");
    expect(result.transportAttempts).toBe(2);
    warnSpy.mockRestore();
  });

  test("AUTH 错误不会吞掉后去 fallback（默认模型即使不同）", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    runSpy.mockImplementation(() =>
      Promise.reject(new Error("OPENAI_API_KEY is required for openai provider"))
    );
    // loadModelConfig is mocked indirectly by same provider — ensure reject before fallback path
    await expect(
      invokeWithFallback(MOCK_CONFIG, {
        systemPrompt: "s",
        userPrompt: "u",
        onToken: () => {},
      })
    ).rejects.toMatchObject({ code: "AUTH", fallbackEligible: false });
    warnSpy.mockRestore();
  });
});

/** 让 ts 编译器认可上面 `mock` 的引入（避免未用 import 警告） */
void mock;
