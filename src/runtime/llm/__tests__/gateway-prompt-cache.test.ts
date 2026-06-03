/**
 * Gateway P3-1 单测：Anthropic prompt-caching opt-in。
 *
 * 覆盖：
 *   1) 默认（无 ENV）：长 / 短 system 都不启用 caching，请求体里没有 anthropic-beta header
 *      也没有 cache_control block —— 与 P2 行为完全一致（向后兼容）。
 *   2) ENV `QUBIT_LLM_ANTHROPIC_PROMPT_CACHE=1`：无视长度直接启用
 *      → 请求加 `anthropic-beta: prompt-caching-2024-07-31`
 *      → system 字段从 string 变成带 cache_control 的 array。
 *   3) ENV `QUBIT_LLM_ANTHROPIC_PROMPT_CACHE_MIN_CHARS`：长度阈值，超过才启用，未超过不启用。
 *   4) 解析 cache_creation_input_tokens 进 usage（验证打点闭环）。
 *
 * 使用非流式 mock（`QUBIT_LLM_ANTHROPIC_NON_STREAM=1`），避免 SSE 复杂度。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runLlmGateway } from "../gateway";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Gateway P3-1 — Anthropic prompt-caching opt-in", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const origCache = process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE"];
  const origCacheMin = process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE_MIN_CHARS"];
  const origNonStream = process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];

  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test-anthropic";
    process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = "1";
    delete process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE"];
    delete process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE_MIN_CHARS"];
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (origCache === undefined) delete process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE"];
    else process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE"] = origCache;
    if (origCacheMin === undefined) delete process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE_MIN_CHARS"];
    else process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE_MIN_CHARS"] = origCacheMin;
    if (origNonStream === undefined) delete process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"];
    else process.env["QUBIT_LLM_ANTHROPIC_NON_STREAM"] = origNonStream;
  });

  test("默认（无 ENV）：长 system 也不启用 caching", async () => {
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    fetchSpy.mockImplementation((_url: string | URL, init?: RequestInit) => {
      calls.push({
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Promise.resolve(
        jsonResponse({
          id: "msg_001",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 100, output_tokens: 5 },
        }),
      );
    });

    const longSystem = "x".repeat(20_000); // 20k chars，远超任何合理阈值
    await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test" },
      systemPrompt: longSystem,
      userPrompt: "hi",
      onToken: () => {},
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["anthropic-beta"]).toBeUndefined();
    expect(calls[0]?.body.system).toBe(longSystem); // 仍是 string，不是 array
  });

  test("ENV QUBIT_LLM_ANTHROPIC_PROMPT_CACHE=1 → 启用 caching（header + system block）", async () => {
    process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE"] = "1";
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    fetchSpy.mockImplementation((_url: string | URL, init?: RequestInit) => {
      calls.push({
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return Promise.resolve(
        jsonResponse({
          id: "msg_002",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 100, output_tokens: 5, cache_creation_input_tokens: 95 },
        }),
      );
    });

    const result = await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test" },
      systemPrompt: "短 prompt 也启用",
      userPrompt: "hi",
      onToken: () => {},
    });

    expect(calls[0]?.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(Array.isArray(calls[0]?.body.system)).toBe(true);
    const systemArr = calls[0]?.body.system as Array<Record<string, unknown>>;
    expect(systemArr[0]?.type).toBe("text");
    expect(systemArr[0]?.text).toBe("短 prompt 也启用");
    expect(systemArr[0]?.cache_control).toEqual({ type: "ephemeral" });
    /** P3-1：cache_creation_input_tokens 应解析进 usage */
    expect(result.usage?.cacheCreationInputTokens).toBe(95);
  });

  test("ENV QUBIT_LLM_ANTHROPIC_PROMPT_CACHE_MIN_CHARS=4096：阈值生效", async () => {
    process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE_MIN_CHARS"] = "4096";
    const calls: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
    fetchSpy.mockImplementation((_u: string | URL, init?: RequestInit) => {
      calls.push({
        body: JSON.parse(String(init?.body ?? "{}")),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return Promise.resolve(
        jsonResponse({
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      );
    });

    /** 短 prompt（< 4096 chars）→ 不启用 */
    await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test" },
      systemPrompt: "x".repeat(1024),
      userPrompt: "u",
      onToken: () => {},
    });
    expect(calls[0]?.headers["anthropic-beta"]).toBeUndefined();
    expect(typeof calls[0]?.body.system).toBe("string");

    /** 长 prompt（≥ 4096 chars）→ 启用 */
    await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test" },
      systemPrompt: "x".repeat(4096),
      userPrompt: "u",
      onToken: () => {},
    });
    expect(calls[1]?.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(Array.isArray(calls[1]?.body.system)).toBe(true);
  });

  test("cache_read_input_tokens / cache_creation_input_tokens 同时存在 → usage 都映射", async () => {
    process.env["QUBIT_LLM_ANTHROPIC_PROMPT_CACHE"] = "1";
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          content: [{ type: "text", text: "" }],
          usage: {
            input_tokens: 200,
            output_tokens: 50,
            cache_read_input_tokens: 150,
            cache_creation_input_tokens: 50,
          },
        }),
      ),
    );

    const result = await runLlmGateway({
      config: { provider: "anthropic", model: "claude-3-5-sonnet-latest", apiKey: "sk-test" },
      systemPrompt: "s",
      userPrompt: "u",
      onToken: () => {},
    });

    expect(result.usage?.promptTokens).toBe(200);
    expect(result.usage?.cachedPromptTokens).toBe(150);
    expect(result.usage?.cacheCreationInputTokens).toBe(50);
  });
});
