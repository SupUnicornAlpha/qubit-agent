/**
 * EmbeddingClient 单测 — Memory V2 P2
 *
 * 覆盖：
 *   - MockEmbeddingClient：deterministic / dimension 一致 / 空输入合法
 *   - hashEmbed：相同输入 → 相同向量；相似输入 → 高 cosine；完全不同 → 较低 cosine
 *   - cosineSimilarity：dim mismatch 抛错；零向量返 0
 *   - getDefaultEmbeddingClient：无 key 返 null；setEmbeddingClientForTesting 后命中 mock
 *   - OpenAIEmbeddingClient：无 key 构造抛错
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  MockEmbeddingClient,
  OpenAIEmbeddingClient,
  cosineSimilarity,
  getDefaultEmbeddingClient,
  hashEmbed,
  setEmbeddingClientForTesting,
} from "../embedding-client";

beforeEach(() => {
  setEmbeddingClientForTesting(null);
});

afterEach(() => {
  setEmbeddingClientForTesting(null);
});

describe("MockEmbeddingClient — 基础行为", () => {
  test("deterministic：同输入 → 同向量", async () => {
    const c = new MockEmbeddingClient({ dimension: 32 });
    const a = await c.embed(["hello world"]);
    const b = await c.embed(["hello world"]);
    expect(a.vectors[0]).toEqual(b.vectors[0]);
  });

  test("dimension 一致；批量顺序对齐", async () => {
    const c = new MockEmbeddingClient({ dimension: 24 });
    const res = await c.embed(["a", "b c", "中文测试"]);
    expect(res.vectors.length).toBe(3);
    for (const v of res.vectors) expect(v.length).toBe(24);
  });

  test("空 batch → 0 向量、0 token、0 latency", async () => {
    const c = new MockEmbeddingClient();
    const res = await c.embed([]);
    expect(res.vectors.length).toBe(0);
    expect(res.tokensUsed).toBe(0);
    expect(res.latencyMs).toBe(0);
  });

  test("calls 暴露：测试可断言 batch 次数", async () => {
    const c = new MockEmbeddingClient();
    await c.embed(["x"]);
    await c.embed(["y", "z"]);
    expect(c.calls.length).toBe(2);
    expect(c.calls[1]?.texts).toEqual(["y", "z"]);
  });
});

describe("hashEmbed — 语义相似性近似", () => {
  test("相同字符串 → cosine = 1（自身）", () => {
    const a = hashEmbed("backtest momentum 20d", 64);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
  });

  test("高度重合的字符串 → cosine 显著高于完全不同", () => {
    const a = hashEmbed("backtest momentum 20d on CN-A market", 128);
    const b = hashEmbed("backtest momentum 20d on US market", 128);
    const c = hashEmbed("apple banana cherry", 128);
    const simAB = cosineSimilarity(a, b);
    const simAC = cosineSimilarity(a, c);
    expect(simAB).toBeGreaterThan(simAC);
    expect(simAB).toBeGreaterThan(0.3);
  });

  test("中文 token 也参与", () => {
    const a = hashEmbed("回测动量因子", 64);
    const b = hashEmbed("回测动量因子有效性", 64);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.5);
  });
});

describe("cosineSimilarity — 健壮性", () => {
  test("零向量 → 0", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  test("dim mismatch 抛错", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/dim/);
  });
});

describe("getDefaultEmbeddingClient — 工厂", () => {
  test("无 mock、无 OPENAI_API_KEY → null（caller 应降级）", () => {
    const oldKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = undefined;
    try {
      const c = getDefaultEmbeddingClient();
      expect(c).toBeNull();
    } finally {
      if (oldKey) process.env.OPENAI_API_KEY = oldKey;
    }
  });

  test("setEmbeddingClientForTesting 后命中 mock", () => {
    const mock = new MockEmbeddingClient();
    setEmbeddingClientForTesting(mock);
    expect(getDefaultEmbeddingClient()).toBe(mock);
  });
});

describe("OpenAIEmbeddingClient — 构造失败兜底", () => {
  test("无 OPENAI_API_KEY + 无 apiKey 参数 → 构造抛错", () => {
    const old = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = undefined;
    try {
      expect(() => new OpenAIEmbeddingClient()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (old) process.env.OPENAI_API_KEY = old;
    }
  });

  test("显式 apiKey + model → dimension 正确（不发请求）", () => {
    const c = new OpenAIEmbeddingClient({
      apiKey: "sk-fake",
      model: "text-embedding-3-large",
    });
    expect(c.model).toBe("text-embedding-3-large");
    expect(c.dimension).toBe(3072);
  });

  test("未知模型 → fallback 1536 维", () => {
    const c = new OpenAIEmbeddingClient({
      apiKey: "sk-fake",
      model: "unknown-model-v9",
    });
    expect(c.dimension).toBe(1536);
  });
});
