import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  normalizeOpenAICompatibleBaseUrl,
  normalizeOpenAICompatibleModel,
  resolveOpenAICompatibleChatCompletionsUrl,
  resolveOpenAICompatibleDefaults,
  runLlmGateway,
} from "../gateway";

describe("OpenAI-compatible endpoint normalization", () => {
  test("accepts either an API root or a full chat completions endpoint", () => {
    expect(
      normalizeOpenAICompatibleBaseUrl("https://open.bigmodel.cn/api/paas/v4/chat/completions")
    ).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(
      resolveOpenAICompatibleChatCompletionsUrl("https://dashscope.aliyuncs.com/compatible-mode/v1")
    ).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  });

  test("normalizes the common Zhipu model spelling without changing other providers", () => {
    expect(normalizeOpenAICompatibleModel("zhipu", "glm5.2")).toBe("glm-5.2");
    expect(normalizeOpenAICompatibleModel("zhipu", "glm-5.2")).toBe("glm-5.2");
    expect(normalizeOpenAICompatibleModel("qwen", "qwen-plus")).toBe("qwen-plus");
  });

  test("uses an explicit generic-compatible contract instead of guessing OpenAI", () => {
    expect(resolveOpenAICompatibleDefaults("openai_compatible")).toEqual({
      envKey: "QUBIT_LLM_OPENAI_COMPATIBLE_API_KEY",
    });
  });
});

describe("OpenAI-compatible streaming gateway", () => {
  const originalCompatStream = process.env.QUBIT_LLM_COMPAT_STREAM;
  const originalCompatNonStream = process.env.QUBIT_LLM_COMPAT_NON_STREAM;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.QUBIT_LLM_COMPAT_STREAM = undefined;
    process.env.QUBIT_LLM_COMPAT_NON_STREAM = undefined;
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    process.env.QUBIT_LLM_COMPAT_STREAM = originalCompatStream;
    process.env.QUBIT_LLM_COMPAT_NON_STREAM = originalCompatNonStream;
  });

  test("defaults to true streaming and does not duplicate the endpoint path", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    fetchSpy.mockImplementation((url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      const encoder = new TextEncoder();
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const data of [
                {
                  id: "zhipu-test",
                  choices: [{ delta: { content: "O" }, finish_reason: null }],
                },
                {
                  id: "zhipu-test",
                  choices: [{ delta: { content: "K" }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
                },
              ]) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        )
      );
    });

    const tokens: string[] = [];
    const result = await runLlmGateway({
      config: {
        provider: "zhipu",
        model: "glm5.2",
        apiKey: "test-key",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      },
      systemPrompt: "system",
      userPrompt: "ping",
      onToken: (token) => tokens.push(token),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(calls[0]?.body.model).toBe("glm-5.2");
    expect(calls[0]?.body.stream).toBe(true);
    expect(tokens).toEqual(["O", "K"]);
    expect(result.answer).toBe("OK");
  });

  test("streams reasoning_content to onReasoningToken without polluting answer", async () => {
    fetchSpy.mockImplementation(() => {
      const encoder = new TextEncoder();
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const data of [
                {
                  id: "r1",
                  choices: [{ delta: { reasoning_content: "先想" }, finish_reason: null }],
                },
                {
                  id: "r1",
                  choices: [{ delta: { reasoning_content: "一步" }, finish_reason: null }],
                },
                {
                  id: "r1",
                  choices: [{ delta: { content: "结论" }, finish_reason: "stop" }],
                  usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
                },
              ]) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }
        )
      );
    });

    const tokens: string[] = [];
    const reasoning: string[] = [];
    const result = await runLlmGateway({
      config: {
        provider: "deepseek",
        model: "deepseek-reasoner",
        apiKey: "test-key",
        baseUrl: "https://api.deepseek.com",
      },
      systemPrompt: "system",
      userPrompt: "ping",
      onToken: (token) => tokens.push(token),
      onReasoningToken: (token) => reasoning.push(token),
    });

    expect(reasoning).toEqual(["先想", "一步"]);
    expect(tokens).toEqual(["结论"]);
    expect(result.answer).toBe("结论");
  });

  test("runs an arbitrary OpenAI-compatible endpoint without a vendor-specific model name", async () => {
    const calls: string[] = [];
    fetchSpy.mockImplementation((url: string | URL) => {
      calls.push(String(url));
      const encoder = new TextEncoder();
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })}\n\n`
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
      );
    });

    const result = await runLlmGateway({
      config: {
        provider: "openai_compatible",
        model: "arbitrary-provider/model-v1",
        apiKey: "test-key",
        baseUrl: "https://gateway.example/v1/chat/completions",
      },
      systemPrompt: "system",
      userPrompt: "ping",
      onToken: () => {},
    });

    expect(calls).toEqual(["https://gateway.example/v1/chat/completions"]);
    expect(result.answer).toBe("OK");
  });

  test("explicit non-stream fallback remains available for legacy proxies", async () => {
    process.env.QUBIT_LLM_COMPAT_NON_STREAM = "1";
    fetchSpy.mockImplementation((_url: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body ?? "{}")).stream).toBe(false);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "zhipu-non-stream",
            choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    });

    const result = await runLlmGateway({
      config: {
        provider: "zhipu",
        model: "glm5.2",
        apiKey: "test-key",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      },
      systemPrompt: "system",
      userPrompt: "ping",
      onToken: () => {},
    });

    expect(result.answer).toBe("OK");
  });
});
