import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  normalizeOpenAICompatibleBaseUrl,
  normalizeOpenAICompatibleModel,
  resolveOpenAICompatibleChatCompletionsUrl,
  runLlmGateway,
} from "../gateway";

describe("OpenAI-compatible endpoint normalization", () => {
  test("accepts either an API root or a full chat completions endpoint", () => {
    expect(
      normalizeOpenAICompatibleBaseUrl(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      ),
    ).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(
      resolveOpenAICompatibleChatCompletionsUrl(
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      ),
    ).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  });

  test("normalizes the common Zhipu model spelling without changing other providers", () => {
    expect(normalizeOpenAICompatibleModel("zhipu", "glm5.2")).toBe("glm-5.2");
    expect(normalizeOpenAICompatibleModel("zhipu", "glm-5.2")).toBe("glm-5.2");
    expect(normalizeOpenAICompatibleModel("qwen", "qwen-plus")).toBe("qwen-plus");
  });
});

describe("Zhipu non-stream gateway", () => {
  const originalCompatStream = process.env["QUBIT_LLM_COMPAT_STREAM"];
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    delete process.env["QUBIT_LLM_COMPAT_STREAM"];
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (originalCompatStream === undefined) delete process.env["QUBIT_LLM_COMPAT_STREAM"];
    else process.env["QUBIT_LLM_COMPAT_STREAM"] = originalCompatStream;
  });

  test("does not duplicate version or chat completion path", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    fetchSpy.mockImplementation((url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "zhipu-test",
            choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
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

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(calls[0]?.body.model).toBe("glm-5.2");
    expect(calls[0]?.body.stream).toBe(false);
    expect(result.answer).toBe("OK");
  });
});
