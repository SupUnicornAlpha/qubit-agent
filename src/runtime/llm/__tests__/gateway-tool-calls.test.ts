/**
 * Gateway P3-3 单测：原生 tool_calls 基础设施。
 *
 * 覆盖：
 *   1) 不传 tools → 与 P2 行为零差（请求体不带 tools 字段，结果不带 toolCalls）。
 *   2) Anthropic 非流式 + tools → 请求体包含 tools（Anthropic schema with input_schema），
 *      响应里 tool_use blocks 解析进 result.toolCalls；input 已是 object 不需要 JSON.parse。
 *   3) Responses API 非流式 + tools → 请求体 tools schema（top-level type:'function' + name），
 *      响应里 output[].type='function_call' 解析进 result.toolCalls；arguments 是 stringified JSON。
 *   4) parseToolArguments 容错：非法 JSON 字符串 → args={}, rawArgs 保留原文（不抛错）。
 *
 * 使用非流式 mock（force ENV）。OpenAI Chat Completions 走 SDK 比较难 mock，
 * 这里通过 OpenAI-compatible（DeepSeek-Chat 等）路径间接覆盖累积器逻辑会比较复杂；
 * 由于核心累积器函数 accumulateOpenAIToolCallDelta / finalizeOpenAIToolCalls 本质纯函数，
 * 单独抽测试会更直接，但目前未导出。Anthropic + Responses 已能覆盖 schema 翻译 + 解析两端。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runLlmGateway, type LlmToolDefinition } from "../gateway";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_TOOL: LlmToolDefinition = {
  name: "fetch_klines",
  description: "Fetch K-line data for a symbol",
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string" },
      interval: { type: "string", enum: ["1m", "5m", "1h", "1d"] },
    },
    required: ["symbol"],
  },
};

describe("Gateway P3-3 — tools opt-in（不传 tools 时零差）", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const origNonStream = process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];
  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test-anthropic";
    process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = "1";
    fetchSpy = spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (origNonStream === undefined) delete process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];
    else process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = origNonStream;
  });

  test("Anthropic：不传 tools → 请求体不带 tools 字段，结果不带 toolCalls", async () => {
    const calls: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation((_u: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });

    const result = await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });

    expect(calls[0]).not.toHaveProperty("tools");
    expect(result.toolCalls).toBeUndefined();
  });
});

describe("Gateway P3-3 — Anthropic tools schema + tool_use 解析", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const origNonStream = process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];
  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test-anthropic";
    process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = "1";
    fetchSpy = spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (origNonStream === undefined) delete process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];
    else process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = origNonStream;
  });

  test("传 tools → 请求体使用 input_schema；响应 tool_use 解析进 result.toolCalls", async () => {
    const calls: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation((_u: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(
        jsonResponse({
          id: "msg_tool_001",
          content: [
            { type: "text", text: "Let me fetch that for you." },
            {
              type: "tool_use",
              id: "toolu_abc123",
              name: "fetch_klines",
              input: { symbol: "BTC-USD", interval: "1h" },
            },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 50, output_tokens: 30 },
        }),
      );
    });

    const result = await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
      tools: [SAMPLE_TOOL],
    });

    /** schema 翻译：Anthropic 用 input_schema，不是 parameters */
    const reqTools = calls[0]?.tools as Array<Record<string, unknown>> | undefined;
    expect(reqTools).toHaveLength(1);
    expect(reqTools?.[0]?.name).toBe("fetch_klines");
    expect(reqTools?.[0]?.input_schema).toEqual(SAMPLE_TOOL.parameters);
    expect(reqTools?.[0]).not.toHaveProperty("parameters");

    /** 解析：tool_use → toolCalls */
    expect(result.finishReason).toBe("tool_use");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.id).toBe("toolu_abc123");
    expect(result.toolCalls?.[0]?.name).toBe("fetch_klines");
    expect(result.toolCalls?.[0]?.args).toEqual({ symbol: "BTC-USD", interval: "1h" });
    expect(result.toolCalls?.[0]?.rawArgs).toBeUndefined(); // input 已是 object，不需要 raw
    /** 文本部分仍正常返回 */
    expect(result.answer).toContain("Let me fetch");
  });
});

describe("Gateway P3-3 — Responses API tools schema + function_call 解析", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const origNonStream = process.env["QUBIT_LLM_RESPONSES_NON_STREAM"];
  beforeEach(() => {
    process.env["OPENAI_API_KEY"] = "sk-test-openai";
    process.env["QUBIT_LLM_RESPONSES_NON_STREAM"] = "1";
    fetchSpy = spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (origNonStream === undefined) delete process.env["QUBIT_LLM_RESPONSES_NON_STREAM"];
    else process.env["QUBIT_LLM_RESPONSES_NON_STREAM"] = origNonStream;
  });

  test("传 tools → Responses 请求体 type='function' + 顶层 name；arguments 是 string 被 JSON.parse", async () => {
    const calls: Array<Record<string, unknown>> = [];
    fetchSpy.mockImplementation((_u: string | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")));
      return Promise.resolve(
        jsonResponse({
          id: "resp_tool_001",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_xyz",
              name: "fetch_klines",
              arguments: '{"symbol":"AAPL","interval":"1d"}',
            },
          ],
          usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
        }),
      );
    });

    const result = await runLlmGateway({
      config: { provider: "openai", model: "gpt-5", apiKey: "sk-test" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
      tools: [SAMPLE_TOOL],
    });

    const reqTools = calls[0]?.tools as Array<Record<string, unknown>> | undefined;
    expect(reqTools).toHaveLength(1);
    expect(reqTools?.[0]?.type).toBe("function");
    expect(reqTools?.[0]?.name).toBe("fetch_klines"); // 顶层 name（与 chat.completions 嵌套结构区分）
    expect(reqTools?.[0]?.parameters).toEqual(SAMPLE_TOOL.parameters);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.id).toBe("call_xyz");
    expect(result.toolCalls?.[0]?.name).toBe("fetch_klines");
    expect(result.toolCalls?.[0]?.args).toEqual({ symbol: "AAPL", interval: "1d" });
    expect(result.toolCalls?.[0]?.rawArgs).toBe('{"symbol":"AAPL","interval":"1d"}');
  });

  test("非法 JSON arguments → args={} 且 rawArgs 保留（fail-soft）", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          id: "resp_bad_args",
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_bad",
              name: "fetch_klines",
              arguments: '{ broken json',
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      ),
    );

    const result = await runLlmGateway({
      config: { provider: "openai", model: "gpt-5", apiKey: "sk-test" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
      tools: [SAMPLE_TOOL],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]?.args).toEqual({}); // fail-soft 不抛错
    expect(result.toolCalls?.[0]?.rawArgs).toBe("{ broken json");
  });
});
