/**
 * LlmRouter 单元测试 — M10.B1
 */

import { describe, expect, test } from "bun:test";
import {
  inferProviderFromModelName,
  parseAgentLlmProviderString,
  providerEnvKey,
} from "../llm-router";

describe("LlmRouter — 解析 Agent.llmProvider 字符串", () => {
  test("'openai:gpt-4o' → provider=openai model=gpt-4o", () => {
    const r = parseAgentLlmProviderString("openai:gpt-4o");
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-4o");
  });

  test("'anthropic:claude-sonnet-4' → provider=anthropic", () => {
    const r = parseAgentLlmProviderString("anthropic:claude-sonnet-4");
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-sonnet-4");
  });

  test("'claude:opus' → provider=anthropic (alias)", () => {
    const r = parseAgentLlmProviderString("claude:opus");
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("opus");
  });

  test("'deepseek:deepseek-chat' → provider=deepseek", () => {
    const r = parseAgentLlmProviderString("deepseek:deepseek-chat");
    expect(r.provider).toBe("deepseek");
  });

  test("'qwen:qwen-plus' / 'zhipu:glm-4' / 'glm:glm-4' 都能识别", () => {
    expect(parseAgentLlmProviderString("qwen:qwen-plus").provider).toBe("qwen");
    expect(parseAgentLlmProviderString("zhipu:glm-4").provider).toBe("zhipu");
    expect(parseAgentLlmProviderString("glm:glm-4").provider).toBe("zhipu");
  });

  test("'ollama:llama3.1' → provider=ollama", () => {
    expect(parseAgentLlmProviderString("ollama:llama3.1").provider).toBe("ollama");
  });

  test("空字符串 / null / undefined → provider=null", () => {
    expect(parseAgentLlmProviderString("").provider).toBe(null);
    expect(parseAgentLlmProviderString(undefined).provider).toBe(null);
    expect(parseAgentLlmProviderString(null).provider).toBe(null);
  });

  test("未知 alias → provider=null", () => {
    expect(parseAgentLlmProviderString("xunfei:spark").provider).toBe(null);
  });

  test("'openai' 没有冒号 → provider=openai model=''", () => {
    const r = parseAgentLlmProviderString("openai");
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("");
  });
});

describe("LlmRouter — modelName 推断 runtime provider", () => {
  test("gpt-4o → openai", () => {
    expect(inferProviderFromModelName("gpt-4o")).toBe("openai");
  });
  test("o1-preview / o3-mini → openai", () => {
    expect(inferProviderFromModelName("o1-preview")).toBe("openai");
    expect(inferProviderFromModelName("o3-mini")).toBe("openai");
  });
  test("claude-sonnet-4 → anthropic", () => {
    expect(inferProviderFromModelName("claude-sonnet-4")).toBe("anthropic");
  });
  test("deepseek-chat → deepseek", () => {
    expect(inferProviderFromModelName("deepseek-chat")).toBe("deepseek");
  });
  test("qwen-plus → qwen", () => {
    expect(inferProviderFromModelName("qwen-plus")).toBe("qwen");
  });
  test("glm-4-flash → zhipu", () => {
    expect(inferProviderFromModelName("glm-4-flash")).toBe("zhipu");
  });
  test("llama3.1 → ollama", () => {
    expect(inferProviderFromModelName("llama3.1")).toBe("ollama");
  });
  test("无法识别 → 默认 openai 兜底", () => {
    expect(inferProviderFromModelName("unknown-model-foo")).toBe("openai");
  });
});

describe("LlmRouter — providerEnvKey 映射", () => {
  test("各 provider 都有正确的 env key", () => {
    expect(providerEnvKey("openai")).toBe("OPENAI_API_KEY");
    expect(providerEnvKey("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(providerEnvKey("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(providerEnvKey("qwen")).toBe("DASHSCOPE_API_KEY");
    expect(providerEnvKey("zhipu")).toBe("ZHIPU_API_KEY");
  });
  test("ollama / mock 不需要 env key", () => {
    expect(providerEnvKey("ollama")).toBe(null);
    expect(providerEnvKey("mock")).toBe(null);
  });
});
