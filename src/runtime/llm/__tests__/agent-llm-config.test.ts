/**
 * agent-llm-config 单元测试。覆盖 DB 反序列化各种边界形态：
 *   - null / undefined / 空字符串 / 非对象 → {}
 *   - 已序列化对象（drizzle JSON 列）/ 字符串 JSON 双形态
 *   - 越界数字 / 负数 / 非有限值 → drop 该字段
 *   - reasoningEffort 非允许值 → drop
 *   - snake_case 兼容（top_p / max_tokens / reasoning_effort）
 *   - 未知 key 一律忽略，不污染 sampling
 */

import { describe, expect, test } from "bun:test";
import { agentLlmConfigToSampling, parseLlmConfigJson } from "../agent-llm-config";

describe("parseLlmConfigJson — 兜底", () => {
  test("null / undefined / 空字符串 → {}", () => {
    expect(parseLlmConfigJson(null)).toEqual({});
    expect(parseLlmConfigJson(undefined)).toEqual({});
    expect(parseLlmConfigJson("")).toEqual({});
    expect(parseLlmConfigJson("   ")).toEqual({});
  });

  test("非对象（数组 / 数字 / boolean） → {}", () => {
    expect(parseLlmConfigJson([1, 2])).toEqual({});
    expect(parseLlmConfigJson(123)).toEqual({});
    expect(parseLlmConfigJson(true)).toEqual({});
  });

  test("非法 JSON 字符串 → {}（不抛错）", () => {
    expect(parseLlmConfigJson("{not json")).toEqual({});
  });
});

describe("parseLlmConfigJson — 已知字段提取", () => {
  test("temperature / topP / maxOutputTokens / reasoningEffort 都接受", () => {
    const cfg = parseLlmConfigJson({
      temperature: 0.3,
      topP: 0.9,
      maxOutputTokens: 8192,
      reasoningEffort: "high",
    });
    expect(cfg).toEqual({
      temperature: 0.3,
      topP: 0.9,
      maxOutputTokens: 8192,
      reasoningEffort: "high",
    });
  });

  test("snake_case 兼容 top_p / max_tokens / max_output_tokens / reasoning_effort", () => {
    const cfg = parseLlmConfigJson({
      top_p: 0.8,
      max_tokens: 1024,
      reasoning_effort: "low",
    });
    expect(cfg.topP).toBe(0.8);
    expect(cfg.maxOutputTokens).toBe(1024);
    expect(cfg.reasoningEffort).toBe("low");
  });

  test("camelCase 优先于 snake_case（同时存在时）", () => {
    const cfg = parseLlmConfigJson({ topP: 0.5, top_p: 0.99 });
    expect(cfg.topP).toBe(0.5);
  });

  test("JSON 字符串形式也支持", () => {
    const cfg = parseLlmConfigJson('{"temperature":0.7,"maxOutputTokens":2048}');
    expect(cfg).toEqual({ temperature: 0.7, maxOutputTokens: 2048 });
  });
});

describe("parseLlmConfigJson — 范围 / 类型校验", () => {
  test("temperature 越界 / 非数字 → drop", () => {
    expect(parseLlmConfigJson({ temperature: -0.5 }).temperature).toBeUndefined();
    expect(parseLlmConfigJson({ temperature: 3 }).temperature).toBeUndefined();
    expect(parseLlmConfigJson({ temperature: NaN }).temperature).toBeUndefined();
    expect(parseLlmConfigJson({ temperature: "0.5" }).temperature).toBeUndefined();
  });

  test("topP 越界 → drop（保留 [0,1]）", () => {
    expect(parseLlmConfigJson({ topP: -0.1 }).topP).toBeUndefined();
    expect(parseLlmConfigJson({ topP: 1.5 }).topP).toBeUndefined();
    expect(parseLlmConfigJson({ topP: 0 }).topP).toBe(0);
    expect(parseLlmConfigJson({ topP: 1 }).topP).toBe(1);
  });

  test("maxOutputTokens 必须正整数", () => {
    expect(parseLlmConfigJson({ maxOutputTokens: 0 }).maxOutputTokens).toBeUndefined();
    expect(parseLlmConfigJson({ maxOutputTokens: -100 }).maxOutputTokens).toBeUndefined();
    expect(parseLlmConfigJson({ maxOutputTokens: 100.5 }).maxOutputTokens).toBeUndefined();
    expect(parseLlmConfigJson({ maxOutputTokens: "8192" }).maxOutputTokens).toBeUndefined();
  });

  test("reasoningEffort 仅允许 low/medium/high", () => {
    expect(parseLlmConfigJson({ reasoningEffort: "high" }).reasoningEffort).toBe("high");
    expect(parseLlmConfigJson({ reasoningEffort: "extra" }).reasoningEffort).toBeUndefined();
    expect(parseLlmConfigJson({ reasoningEffort: 1 as unknown }).reasoningEffort).toBeUndefined();
  });

  test("未知 key 不会被透传", () => {
    const cfg = parseLlmConfigJson({ temperature: 0.1, foo: "bar", maxTokens: 999 });
    expect(cfg.temperature).toBe(0.1);
    /** maxTokens 是 snake_case 的兄弟变体（max_tokens 才认），这里 maxTokens 不认 */
    expect(cfg.maxOutputTokens).toBeUndefined();
    expect("foo" in cfg).toBe(false);
  });
});

describe("agentLlmConfigToSampling — 透传", () => {
  test("undefined → {}", () => {
    expect(agentLlmConfigToSampling(undefined)).toEqual({});
  });

  test("非空 cfg → 浅拷贝（不共用引用）", () => {
    const cfg = { temperature: 0.4, maxOutputTokens: 2048 };
    const out = agentLlmConfigToSampling(cfg);
    expect(out).toEqual(cfg);
    expect(out).not.toBe(cfg);
  });
});
