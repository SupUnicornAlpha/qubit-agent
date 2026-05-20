import { beforeEach, describe, expect, test } from "bun:test";
import { providerRegistry } from "../registry";
import { providerResolver } from "../resolver";
import { PythonInlineFactorProvider } from "../impls/factor/python-inline-factor-provider";
import { BuiltinFactorEvalProvider } from "../impls/factor/builtin-factor-eval-provider";
import { JsonLogicRuleProvider } from "../impls/rule/jsonlogic-rule-provider";
import { ProviderError } from "../types";

describe("ProviderRegistry / Resolver", () => {
  beforeEach(() => {
    providerRegistry._resetForTests();
  });

  test("register + list 返回按 priority 排序", () => {
    providerRegistry.register(new PythonInlineFactorProvider());
    const list = providerRegistry.list("factor_compute");
    expect(list.length).toBe(1);
    expect(list[0]?.provider.meta.key).toBe("python_inline");
  });

  test("重复注册同 key 抛错", () => {
    providerRegistry.register(new PythonInlineFactorProvider());
    expect(() => providerRegistry.register(new PythonInlineFactorProvider())).toThrow();
  });

  test("pickFallback 优先返回 is_fallback=true 的实现", () => {
    providerRegistry.register(new BuiltinFactorEvalProvider());
    const fb = providerRegistry.pickFallback("factor_eval");
    expect(fb?.meta.key).toBe("builtin");
  });

  test("resolve 无任何 provider 时抛 no_fallback", async () => {
    await expect(providerResolver.resolve("backtest", {}, { skipFallback: true })).rejects.toBeInstanceOf(
      ProviderError
    );
  });

  test("显式 providerKey 优先于默认链路", async () => {
    providerRegistry.register(new PythonInlineFactorProvider());
    const p = await providerResolver.resolve(
      "factor_compute",
      {},
      { providerKey: "python_inline" }
    );
    expect(p.meta.key).toBe("python_inline");
  });

  test("FactorEval 内置 pearson 计算 IC 与 RankIC", async () => {
    providerRegistry.register(new BuiltinFactorEvalProvider());
    const ev = await providerResolver.resolve("factor_eval");
    const result = await ev.evaluate({
      factorId: "f1",
      universe: "TEST",
      values: [
        { symbol: "A", date: "2026-01-01", value: 0.1 },
        { symbol: "B", date: "2026-01-01", value: 0.2 },
        { symbol: "C", date: "2026-01-01", value: 0.3 },
        { symbol: "D", date: "2026-01-01", value: 0.4 },
        { symbol: "E", date: "2026-01-01", value: 0.5 },
        { symbol: "F", date: "2026-01-01", value: 0.6 },
      ],
      futureReturns: [
        { symbol: "A", date: "2026-01-01", value: 0.01 },
        { symbol: "B", date: "2026-01-01", value: 0.03 },
        { symbol: "C", date: "2026-01-01", value: 0.06 },
        { symbol: "D", date: "2026-01-01", value: 0.08 },
        { symbol: "E", date: "2026-01-01", value: 0.1 },
        { symbol: "F", date: "2026-01-01", value: 0.12 },
      ],
    });
    expect(result.ic).toBeGreaterThan(0.95);
    expect(result.rankIc).toBeCloseTo(1, 3);
    expect(result.sampleSize).toBe(6);
  });

  test("JsonLogic Rule：score + when 联合评估", async () => {
    providerRegistry.register(new JsonLogicRuleProvider());
    const rule = await providerResolver.resolve("rule_engine");
    const parsed = await rule.parse(
      {
        when: { and: [{ ">": [{ factor: "mom" }, 0] }, { "<": [{ factor: "pe" }, 30] }] },
        score: { weighted_sum: [{ factor: "mom", w: 0.7 }, { factor: "quality", w: 0.3 }] },
      },
      "jsonlogic"
    );
    expect(parsed.ok).toBe(true);

    const result = await rule.evaluate(
      {
        lang: "jsonlogic",
        appliesTo: "score",
        dsl: parsed.ast,
      },
      {
        asof: "2026-05-20",
        universe: "TEST",
        factorContext: {
          A: { mom: 0.05, pe: 20, quality: 0.8 },
          B: { mom: 0.02, pe: 35, quality: 0.7 }, // pe>30 → filtered
          C: { mom: -0.01, pe: 25, quality: 0.9 }, // mom<=0 → filtered
        },
      }
    );
    const a = result.symbols.find((s) => s.symbol === "A")!;
    const b = result.symbols.find((s) => s.symbol === "B")!;
    const c = result.symbols.find((s) => s.symbol === "C")!;
    expect(a.passed).toBe(true);
    expect(a.score).toBeCloseTo(0.05 * 0.7 + 0.8 * 0.3, 3);
    expect(b.passed).toBe(false);
    expect(c.passed).toBe(false);
  });
});
