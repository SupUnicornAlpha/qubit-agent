/**
 * Gateway P1 单元测试：Anthropic / OpenAI Responses 真流式 SSE。
 *
 * 覆盖点：
 *   1) Anthropic SSE：text_delta 累积、message_start 拿 responseId、
 *      message_delta 拿 stop_reason + output_tokens、cache_read_input_tokens 落到
 *      cachedPromptTokens。
 *   2) firstTokenLatencyMs 在首次 text_delta 到达时记录，与整段 latency 不同。
 *   3) OpenAI Responses SSE：response.created 拿 id、output_text.delta 累积 token、
 *      response.completed 拿 usage（reasoning_tokens / cached_tokens）+ stop。
 *   4) Responses 流中 error 事件 → 抛错（让外层走 fallback / 熔断）。
 *   5) ENV 兜底：QUBIT_LLM_ANTHROPIC_NON_STREAM=1 / QUBIT_LLM_RESPONSES_NON_STREAM=1
 *      时回退到非流式（与 P0 行为一致）。
 *
 * mock 策略：
 *   - 所有 fetch 走 globalThis.fetch；spyOn 拦截后用 ReadableStream 构造一个
 *     SSE 流，让 readSseEvents 真实跑过去。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runLlmGateway } from "../gateway";

function sseStreamResponse(events: Array<{ event?: string; data: unknown }>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        const eventLine = ev.event ? `event: ${ev.event}\n` : "";
        const dataLine = `data: ${typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data)}\n\n`;
        controller.enqueue(encoder.encode(eventLine + dataLine));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Gateway P1 — Anthropic streaming SSE", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const origNonStream = process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];

  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test";
    delete process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (origNonStream === undefined) delete process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];
    else process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = origNonStream;
  });

  test("text_delta 累积 + responseId + stop_reason + cachedPromptTokens", async () => {
    fetchSpy.mockImplementation((_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.stream).toBe(true);
      return Promise.resolve(
        sseStreamResponse([
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: {
                id: "msg_p1_a1",
                usage: { input_tokens: 50, cache_read_input_tokens: 10, output_tokens: 0 },
              },
            },
          },
          {
            event: "content_block_delta",
            data: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
          },
          {
            event: "content_block_delta",
            data: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 7 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]),
      );
    });

    const tokens: string[] = [];
    const result = await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: (t) => tokens.push(t),
    });

    expect(result.answer).toBe("Hello world");
    expect(tokens).toEqual(["Hello", " world"]);
    expect(result.responseId).toBe("msg_p1_a1");
    expect(result.finishReason).toBe("end_turn");
    expect(result.usage?.promptTokens).toBe(50);
    expect(result.usage?.completionTokens).toBe(7);
    expect(result.usage?.cachedPromptTokens).toBe(10);
    /** firstTokenLatencyMs 应被设置（与整段 latency 可能相等也可能更小） */
    expect(result.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.firstTokenLatencyMs).toBeLessThanOrEqual(result.latencyMs);
  });

  test("ENV QUBIT_LLM_ANTHROPIC_NON_STREAM=1 → 回退非流式（兼容老代理）", async () => {
    process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = "1";
    fetchSpy.mockImplementation((_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.stream).toBeUndefined();
      return Promise.resolve(
        jsonResponse({
          id: "msg_compat",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 1 },
        }),
      );
    });
    const result = await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });
    expect(result.answer).toBe("ok");
    expect(result.responseId).toBe("msg_compat");
  });
});

describe("Gateway P1 — OpenAI Responses streaming SSE", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const origNonStream = process.env["QUBIT_LLM_RESPONSES_NON_STREAM"];

  beforeEach(() => {
    process.env["OPENAI_API_KEY"] = "sk-test-openai";
    delete process.env["QUBIT_LLM_RESPONSES_NON_STREAM"];
    delete process.env["QUBIT_LLM_USE_RESPONSES_API"];
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (origNonStream === undefined) delete process.env["QUBIT_LLM_RESPONSES_NON_STREAM"];
    else process.env["QUBIT_LLM_RESPONSES_NON_STREAM"] = origNonStream;
  });

  test("output_text.delta 累积 + response.completed 拿 usage / finishReason", async () => {
    fetchSpy.mockImplementation((url: string | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/v1/responses");
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.stream).toBe(true);
      return Promise.resolve(
        sseStreamResponse([
          {
            event: "response.created",
            data: { type: "response.created", response: { id: "resp_p1_b1" } },
          },
          {
            event: "response.output_text.delta",
            data: { type: "response.output_text.delta", delta: "Hi" },
          },
          {
            event: "response.output_text.delta",
            data: { type: "response.output_text.delta", delta: " there" },
          },
          {
            event: "response.completed",
            data: {
              type: "response.completed",
              response: {
                id: "resp_p1_b1",
                status: "completed",
                usage: {
                  input_tokens: 80,
                  output_tokens: 20,
                  total_tokens: 100,
                  input_tokens_details: { cached_tokens: 32 },
                  output_tokens_details: { reasoning_tokens: 5 },
                },
              },
            },
          },
        ]),
      );
    });

    const tokens: string[] = [];
    const result = await runLlmGateway({
      config: { provider: "openai", model: "gpt-5-mini", apiKey: "sk-test-openai" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: (t) => tokens.push(t),
    });

    expect(tokens).toEqual(["Hi", " there"]);
    expect(result.answer).toBe("Hi there");
    expect(result.responseId).toBe("resp_p1_b1");
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.cachedPromptTokens).toBe(32);
    expect(result.usage?.reasoningTokens).toBe(5);
    expect(result.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
  });

  test("流中 response.error 事件 → 抛错（让外层走 fallback）", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        sseStreamResponse([
          {
            event: "response.error",
            data: { type: "response.error", error: { message: "rate limit", code: "rate_limit_exceeded" } },
          },
        ]),
      ),
    );

    let threw: Error | null = null;
    try {
      await runLlmGateway({
        config: { provider: "openai", model: "gpt-5", apiKey: "sk-test-openai" },
        systemPrompt: "s",
        userPrompt: "u",
        onToken: () => {},
      });
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).not.toBeNull();
    expect(threw?.message).toContain("rate limit");
  });

  test("ENV QUBIT_LLM_RESPONSES_NON_STREAM=1 → 回退非流式", async () => {
    process.env["QUBIT_LLM_RESPONSES_NON_STREAM"] = "1";
    fetchSpy.mockImplementation((_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.stream).toBe(false);
      return Promise.resolve(
        jsonResponse({
          id: "resp_compat",
          status: "completed",
          output_text: "ok",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });
    const result = await runLlmGateway({
      config: { provider: "openai", model: "gpt-5", apiKey: "sk-test-openai" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });
    expect(result.responseId).toBe("resp_compat");
  });
});
