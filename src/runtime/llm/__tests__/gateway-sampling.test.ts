/**
 * Gateway P0 单元测试：sampling 入参 + Responses API 路径 + 新打点字段。
 *
 * 覆盖点：
 *   1) Anthropic 默认 max_tokens 从 1024 升到 4096（旧默认太小常被截断）
 *   2) Anthropic sampling.maxOutputTokens 覆写默认
 *   3) provider=openai + model=gpt-5* → 路由到 /v1/responses，发出 reasoning.effort
 *      并 strip 掉 temperature/top_p（推理模型不允许）
 *   4) Responses API 返回的 cached_tokens / reasoning_tokens / response id / status
 *      被正确解析进 LlmGatewayResult
 *   5) ENV `QUBIT_LLM_USE_RESPONSES_API="0"` 强制回到 chat.completions（兜底场景）
 *
 * mock 策略：
 *   - Anthropic / Responses 路径都走 fetchWithTimeout → globalThis.fetch；spyOn 全局 fetch
 *     可以同时拦截，不依赖 OpenAI SDK 实现细节，与 P0 实现"用 fetch 调 /v1/responses
 *     而非 client.responses.create"的低耦合策略一致。
 *   - chat.completions 路径用 OpenAI SDK，本测试不覆盖（已有 model-capabilities 单测
 *     验证 sanitize 行为）。
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { runLlmGateway } from "../gateway";

type MockResponseInit = {
  ok: boolean;
  status: number;
  body: unknown;
};

function jsonResponse(init: MockResponseInit): Response {
  return new Response(JSON.stringify(init.body), {
    status: init.status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Gateway P0 — Anthropic sampling", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const origNonStream = process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];

  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test-anthropic";
    /**
     * P0 这组覆盖的是 sampling 字段下发 / 默认值，与流式协议无关；
     * P1 把流式作为默认后，这里 force 走非流式让 mock 用普通 JSON 即可。
     * Streaming 协议的覆盖见 gateway-streaming.test.ts。
     */
    process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = "1";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (origNonStream === undefined) delete process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];
    else process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = origNonStream;
  });

  test("默认 max_tokens=4096（修复历史 1024 截断问题）", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    fetchSpy.mockImplementation((url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Promise.resolve(
        jsonResponse({
          ok: true,
          status: 200,
          body: {
            id: "msg_test_001",
            content: [{ type: "text", text: "hi" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        }),
      );
    });

    const result = await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test-anthropic" },
      systemPrompt: "sys",
      userPrompt: "hi",
      onToken: () => {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/v1/messages");
    expect(calls[0]?.body.max_tokens).toBe(4096);
    expect(calls[0]?.body.temperature).toBe(0.1);
    expect(result.responseId).toBe("msg_test_001");
    expect(result.finishReason).toBe("end_turn");
  });

  test("sampling.maxOutputTokens 覆写默认 max_tokens", async () => {
    const calls: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation((_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(
        jsonResponse({
          ok: true,
          status: 200,
          body: {
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        }),
      );
    });

    await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test-anthropic" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
      sampling: { maxOutputTokens: 8192, temperature: 0.7 },
    });

    expect(calls[0]?.max_tokens).toBe(8192);
    expect(calls[0]?.temperature).toBe(0.7);
  });
});

describe("Gateway P0 — OpenAI Responses API 路由", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const origForceChat = process.env["QUBIT_LLM_USE_RESPONSES_API"];
  const origNonStream = process.env["QUBIT_LLM_RESPONSES_NON_STREAM"];

  beforeEach(() => {
    process.env["OPENAI_API_KEY"] = "sk-test-openai";
    delete process.env["QUBIT_LLM_USE_RESPONSES_API"];
    /**
     * 同 P0 Anthropic 组：流式协议在 gateway-streaming.test.ts 单独覆盖，
     * 这里只关心 sampling 字段路由 / sanitize / finishReason 解析，
     * force NON_STREAM 让 mock 用普通 JSON 即可。
     */
    process.env["QUBIT_LLM_RESPONSES_NON_STREAM"] = "1";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (origForceChat === undefined) {
      delete process.env["QUBIT_LLM_USE_RESPONSES_API"];
    } else {
      process.env["QUBIT_LLM_USE_RESPONSES_API"] = origForceChat;
    }
    if (origNonStream === undefined) delete process.env["QUBIT_LLM_RESPONSES_NON_STREAM"];
    else process.env["QUBIT_LLM_RESPONSES_NON_STREAM"] = origNonStream;
  });

  test("provider=openai + model=gpt-5* → 路由到 /v1/responses，带 reasoning.effort=medium", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    fetchSpy.mockImplementation((url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Promise.resolve(
        jsonResponse({
          ok: true,
          status: 200,
          body: {
            id: "resp_test_a1",
            status: "completed",
            output_text: "answer",
            usage: {
              input_tokens: 100,
              output_tokens: 30,
              total_tokens: 130,
              input_tokens_details: { cached_tokens: 40 },
              output_tokens_details: { reasoning_tokens: 12 },
            },
          },
        }),
      );
    });

    const result = await runLlmGateway({
      config: { provider: "openai", model: "gpt-5-mini", apiKey: "sk-test-openai" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/v1/responses");
    /** 推理模型 strip 掉 temperature / top_p */
    expect(calls[0]?.body.temperature).toBeUndefined();
    expect(calls[0]?.body.top_p).toBeUndefined();
    /** reasoning effort 默认 medium */
    expect(calls[0]?.body.reasoning).toEqual({ effort: "medium" });
    /** Responses API 字段名是 max_output_tokens 而非 max_tokens */
    expect(calls[0]?.body.max_output_tokens).toBe(4096);
    expect(calls[0]?.body.max_tokens).toBeUndefined();
    /** 解析 usage 里的 cached / reasoning */
    expect(result.usage?.cachedPromptTokens).toBe(40);
    expect(result.usage?.reasoningTokens).toBe(12);
    expect(result.responseId).toBe("resp_test_a1");
    expect(result.finishReason).toBe("stop");
    expect(result.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test("sampling.reasoningEffort 覆盖默认 effort", async () => {
    const calls: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation((_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(
        jsonResponse({
          ok: true,
          status: 200,
          body: { id: "resp_2", status: "completed", output_text: "ok", usage: { input_tokens: 1, output_tokens: 1 } },
        }),
      );
    });

    await runLlmGateway({
      config: { provider: "openai", model: "o3-mini", apiKey: "sk-test-openai" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
      sampling: { reasoningEffort: "high", maxOutputTokens: 16384 },
    });

    expect(calls[0]?.reasoning).toEqual({ effort: "high" });
    expect(calls[0]?.max_output_tokens).toBe(16384);
  });

  test("status='incomplete' → finishReason 取 incomplete_details.reason", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          ok: true,
          status: 200,
          body: {
            id: "resp_truncated",
            status: "incomplete",
            output_text: "partial",
            incomplete_details: { reason: "max_output_tokens" },
            usage: { input_tokens: 100, output_tokens: 4096 },
          },
        }),
      ),
    );

    const result = await runLlmGateway({
      config: { provider: "openai", model: "gpt-5", apiKey: "sk-test-openai" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });
    expect(result.finishReason).toBe("max_output_tokens");
  });

  test("ENV QUBIT_LLM_USE_RESPONSES_API=0 → 即使 reasoning model 也不走 responses（兜底给老代理）", async () => {
    process.env["QUBIT_LLM_USE_RESPONSES_API"] = "0";
    /**
     * 不 mock fetch：如果误走 responses 会抛网络错误；当前期望走 chat.completions
     * 路径，而 chat.completions 用 OpenAI SDK 在没有真实 key 的情况下会抛 SDK 内部
     * 错误（也不会调到 fetch）。我们只需要断言 fetch 没被调用即可。
     */
    fetchSpy.mockImplementation(() => Promise.reject(new Error("fetch should not be called")));

    let threw = false;
    try {
      await runLlmGateway({
        config: { provider: "openai", model: "gpt-5", apiKey: "sk-test-openai" },
        systemPrompt: "s",
        userPrompt: "u",
        onToken: () => {},
      });
    } catch {
      threw = true;
    }
    /** 路由到 chat 路径后 SDK 会出错（baseURL 非真实），但**绝不**应该调到 /v1/responses 的 fetch */
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(threw).toBe(true);
  });
});

describe("Gateway P0 — Ollama sampling 透传", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("默认不发 options（保持向后兼容），传 sampling 才下发到 options.{...}", async () => {
    const calls: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation((_url: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(
        jsonResponse({
          ok: true,
          status: 200,
          body: {
            message: { content: "ok" },
            prompt_eval_count: 10,
            eval_count: 20,
            done_reason: "stop",
          },
        }),
      );
    });

    /** 不传 sampling */
    await runLlmGateway({
      config: { provider: "ollama", model: "llama3.1", apiKey: "" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });
    expect(calls[0]?.options).toBeUndefined();

    /** 传 sampling */
    await runLlmGateway({
      config: { provider: "ollama", model: "llama3.1", apiKey: "" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
      sampling: { temperature: 0.7, topP: 0.9, maxOutputTokens: 2048 },
    });
    expect(calls[1]?.options).toEqual({
      temperature: 0.7,
      top_p: 0.9,
      num_predict: 2048,
    });
  });
});
