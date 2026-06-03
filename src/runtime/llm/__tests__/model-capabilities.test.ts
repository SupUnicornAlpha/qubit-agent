/**
 * model-capabilities 单测：覆盖
 *   1) passthrough（gpt-4o / gpt-3.5 / claude / 空模型名）：原 body 完全保留
 *   2) reasoning family（gpt-5* / o1 / o3 / o4 / azure/o1）：strip 掉受限字段
 *   3) 不可变性：原入参不被修改
 *   4) 大小写不敏感
 *
 * 触发场景：production 上 gpt-5.5 因为传 temperature=0.1 一直 400 → 熔断器
 * 误开（workflow 051d5cc8-0cfa-40fc-a868-c35935167fe3 重现）。
 */

import { describe, expect, test } from "bun:test";
import { modelCapability, sanitizeChatCompletionsBody } from "../model-capabilities";

describe("modelCapability", () => {
  test("空模型名退化为 FULL profile（不影响老链路）", () => {
    expect(modelCapability(undefined)).toMatchObject({
      customTemperature: true,
      customTopP: true,
      penalties: true,
    });
    expect(modelCapability("")).toMatchObject({ customTemperature: true });
  });

  test("gpt-4o / gpt-4o-mini / gpt-3.5 / deepseek-chat → FULL", () => {
    for (const m of ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo", "deepseek-chat", "qwen-plus", "claude-3-5-sonnet"]) {
      expect(modelCapability(m).customTemperature).toBe(true);
    }
  });

  test("gpt-5 / gpt-5.5 / gpt-5-mini → REASONING", () => {
    for (const m of ["gpt-5", "gpt-5.5", "gpt-5-mini", "gpt-5.2"]) {
      const cap = modelCapability(m);
      expect(cap.customTemperature).toBe(false);
      expect(cap.customTopP).toBe(false);
      expect(cap.penalties).toBe(false);
    }
  });

  test("o1 / o1-mini / o3 / o3-mini / o4-mini → REASONING", () => {
    for (const m of ["o1", "o1-mini", "o1-preview", "o1-pro", "o3", "o3-mini", "o4-mini"]) {
      expect(modelCapability(m).customTemperature).toBe(false);
    }
  });

  test("azure 命名前缀（azure/o1, azure/gpt-5）→ REASONING", () => {
    expect(modelCapability("azure/o1").customTemperature).toBe(false);
    expect(modelCapability("azure/gpt-5-mini").customTemperature).toBe(false);
  });

  test("大小写不敏感", () => {
    expect(modelCapability("GPT-5.5").customTemperature).toBe(false);
    expect(modelCapability("O1-MINI").customTemperature).toBe(false);
  });

  test("apiPath：reasoning 走 responses；其它走 chat", () => {
    expect(modelCapability("gpt-5-mini").apiPath).toBe("responses");
    expect(modelCapability("o3-mini").apiPath).toBe("responses");
    expect(modelCapability("azure/gpt-5").apiPath).toBe("responses");
    expect(modelCapability("gpt-4o").apiPath).toBe("chat");
    expect(modelCapability("claude-3-5-sonnet").apiPath).toBe("chat");
    expect(modelCapability("deepseek-chat").apiPath).toBe("chat");
    expect(modelCapability(undefined).apiPath).toBe("chat");
  });

  test("reasoningEffort：仅 OpenAI Responses reasoning family 为 true", () => {
    expect(modelCapability("gpt-5").reasoningEffort).toBe(true);
    expect(modelCapability("o1-pro").reasoningEffort).toBe(true);
    expect(modelCapability("gpt-4o-mini").reasoningEffort).toBe(false);
    expect(modelCapability("claude-3-5-sonnet").reasoningEffort).toBe(false);
    /** DeepSeek-R1 也是 reasoning model，但走 chat.completions，不暴露 effort 入参 */
    expect(modelCapability("deepseek-r1").reasoningEffort).toBe(false);
    expect(modelCapability("deepseek-reasoner").reasoningEffort).toBe(false);
  });

  test("DeepSeek-R1 / deepseek-reasoner：strip sampling，但 apiPath 仍是 chat", () => {
    for (const m of ["deepseek-r1", "deepseek-reasoner", "DeepSeek-R1", "deepseek-r1-distill"]) {
      const cap = modelCapability(m);
      expect(cap.customTemperature).toBe(false);
      expect(cap.customTopP).toBe(false);
      expect(cap.penalties).toBe(false);
      /** 关键：不能误路由到 /v1/responses（DeepSeek 平台没有这个端点） */
      expect(cap.apiPath).toBe("chat");
    }
  });

  test("sanitize 也对 deepseek-reasoner 生效（chat.completions 路径）", () => {
    const out = sanitizeChatCompletionsBody("deepseek-reasoner", {
      model: "deepseek-reasoner",
      messages: [],
      temperature: 0.5,
      top_p: 0.9,
      frequency_penalty: 0.3,
    }) as Record<string, unknown>;
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.frequency_penalty).toBeUndefined();
    expect(out.model).toBe("deepseek-reasoner");
  });
});

describe("sanitizeChatCompletionsBody", () => {
  const fullBody = {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hi" }],
    temperature: 0.1,
    top_p: 0.9,
    frequency_penalty: 0.5,
    presence_penalty: 0.5,
    stream: true,
  };

  test("passthrough 模型保持原样（gpt-4o）", () => {
    const out = sanitizeChatCompletionsBody("gpt-4o", { ...fullBody, model: "gpt-4o" });
    expect(out.temperature).toBe(0.1);
    expect(out.top_p).toBe(0.9);
    expect(out.frequency_penalty).toBe(0.5);
    expect(out.presence_penalty).toBe(0.5);
    expect(out.stream).toBe(true);
  });

  test("reasoning 模型剔除 temperature / top_p / penalties", () => {
    const out = sanitizeChatCompletionsBody("gpt-5.5", fullBody) as Record<string, unknown>;
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.frequency_penalty).toBeUndefined();
    expect(out.presence_penalty).toBeUndefined();
    /** 必传字段不可被误删 */
    expect(out.model).toBe("gpt-5.5");
    expect(out.messages).toEqual(fullBody.messages);
    expect(out.stream).toBe(true);
  });

  test("o1 也走 reasoning 分支", () => {
    const out = sanitizeChatCompletionsBody("o1-mini", { ...fullBody, model: "o1-mini" }) as Record<
      string,
      unknown
    >;
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
  });

  test("不可变：sanitize 不修改原入参", () => {
    const original = { ...fullBody };
    const snapshot = JSON.stringify(original);
    sanitizeChatCompletionsBody("gpt-5", original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test("body 里没有 temperature 字段也不会报错（仅删除存在的字段）", () => {
    const minimal = {
      model: "gpt-5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const out = sanitizeChatCompletionsBody("gpt-5", minimal) as Record<string, unknown>;
    expect(out.model).toBe("gpt-5");
    expect(out.stream).toBe(true);
  });
});
