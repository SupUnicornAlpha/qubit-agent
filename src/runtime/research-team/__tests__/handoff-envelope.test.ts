import { describe, expect, test } from "bun:test";
import { formatHandoffEnvelopeBlock, parseHandoffEnvelope } from "../handoff-envelope";

describe("parseHandoffEnvelope", () => {
  test("parses trailing fenced json envelope from a markdown report", () => {
    const text = [
      "# 回测报告",
      "绩效摘要：Sharpe 1.2 ...",
      "",
      "```json",
      JSON.stringify({
        thesis: "策略在低波动期稳健",
        falsifiers: ["OOS Sharpe < 0.5", "换手成本翻倍则失效"],
        handoffs: [{ role: "risk", ask: "看集中度与流动性" }],
        metrics: [
          { name: "sharpe", value: 1.2, asof: "2026-06-22", source: "backtest.run" },
          { name: "max_drawdown", value: -0.18, unit: "ratio" },
        ],
        data_refs: [{ kind: "backtest_run", id: "job_abc", note: "全样本" }],
        extensions: { regime_table: { low_vol: 1.4, high_vol: 0.6 } },
      }),
      "```",
    ].join("\n");
    const env = parseHandoffEnvelope(text);
    expect(env).not.toBeNull();
    expect(env?.thesis).toBe("策略在低波动期稳健");
    expect(env?.falsifiers?.length).toBe(2);
    expect(env?.handoffs?.[0]).toEqual({ role: "risk", ask: "看集中度与流动性" });
    expect(env?.metrics?.find((m) => m.name === "sharpe")?.value).toBe(1.2);
    expect(env?.data_refs?.[0]?.id).toBe("job_abc");
    expect(env?.extensions?.regime_table).toBeDefined();
  });

  test("accepts an already-parsed object (analyst structured)", () => {
    const env = parseHandoffEnvelope({
      signal: "buy",
      confidence: 0.7,
      thesis: "盈利质量改善",
      metrics: [{ name: "pe", value: 18 }],
    });
    expect(env?.thesis).toBe("盈利质量改善");
    expect(env?.metrics?.[0]).toEqual({ name: "pe", value: 18 });
  });

  test("coerces metrics map form and string falsifier", () => {
    const env = parseHandoffEnvelope({
      metrics: { pe: 12.3, rank_ic: { value: 0.05, source: "factor.autoEvaluate" } },
      falsifiers: "财报 miss 即翻案",
    });
    expect(env?.metrics?.find((m) => m.name === "pe")?.value).toBe(12.3);
    expect(env?.metrics?.find((m) => m.name === "rank_ic")?.source).toBe("factor.autoEvaluate");
    expect(env?.falsifiers).toEqual(["财报 miss 即翻案"]);
  });

  test("parses string-form handoff '@role ask'", () => {
    const env = parseHandoffEnvelope({ handoffs: ["@analyst_macro 确认利率路径"] });
    expect(env?.handoffs?.[0]).toEqual({ role: "analyst_macro", ask: "确认利率路径" });
  });

  test("returns null on no envelope content", () => {
    expect(parseHandoffEnvelope("just prose, no json")).toBeNull();
    expect(parseHandoffEnvelope(null)).toBeNull();
    expect(parseHandoffEnvelope({ signal: "buy", confidence: 0.5 })).toBeNull();
  });

  test("does not throw on malformed json fence", () => {
    expect(() => parseHandoffEnvelope("```json\n{bad json,,,}\n```")).not.toThrow();
    expect(parseHandoffEnvelope("```json\n{bad json,,,}\n```")).toBeNull();
  });
});

describe("formatHandoffEnvelopeBlock", () => {
  test("renders compact structured block with metrics table + data_refs", () => {
    const block = formatHandoffEnvelopeBlock({
      thesis: "偏多",
      metrics: [{ name: "sharpe", value: 1.2, asof: "2026-06-22", source: "backtest.run" }],
      data_refs: [{ kind: "backtest_run", id: "job_abc", note: "全样本" }],
      handoffs: [{ role: "risk", ask: "看集中度" }],
      falsifiers: ["OOS Sharpe<0.5"],
    });
    expect(block).toContain("**结论**：偏多");
    expect(block).toContain("| 指标 | 值 | 时点 | 来源 |");
    expect(block).toContain("| sharpe | 1.2 | 2026-06-22 | backtest.run |");
    expect(block).toContain("`backtest_run:job_abc`（全样本）");
    expect(block).toContain("risk ← 看集中度");
    expect(block).toContain("OOS Sharpe<0.5");
  });

  test("returns empty string for null/empty envelope", () => {
    expect(formatHandoffEnvelopeBlock(null)).toBe("");
    expect(formatHandoffEnvelopeBlock({})).toBe("");
  });
});
