import { describe, expect, test } from "bun:test";
import { tokenize, ExprLexError } from "../lexer";
import { parse, ExprParseError } from "../parser";
import { evalExpr, type PriceSeries } from "../evaluator";

function ps(close: number[]): PriceSeries {
  return {
    length: close.length,
    fields: {
      close,
      open: close.map((c) => c * 0.99),
      high: close.map((c) => c * 1.01),
      low: close.map((c) => c * 0.98),
      volume: close.map(() => 1000),
      turnover: close.map((c) => c * 1000),
      vwap: close,
    },
  };
}

describe("Lexer", () => {
  test("基础 tokens", () => {
    const toks = tokenize("Mean(close, 20) + 0.5");
    expect(toks.map((t) => t.type)).toEqual([
      "ident",
      "lparen",
      "ident",
      "comma",
      "number",
      "rparen",
      "op",
      "number",
      "eof",
    ]);
  });
  test("非法字符抛 ExprLexError", () => {
    expect(() => tokenize("close @ 5")).toThrow(ExprLexError);
  });
  test("浮点数", () => {
    const toks = tokenize(".5 0.25");
    expect(toks[0]?.value).toBe(".5");
    expect(toks[1]?.value).toBe("0.25");
  });
});

describe("Parser", () => {
  test("优先级：a + b * c", () => {
    const ast = parse("close + volume * 2");
    expect(ast).toMatchObject({
      type: "binop",
      op: "+",
      right: { type: "binop", op: "*" },
    });
  });
  test("函数调用嵌套", () => {
    const ast = parse("Mean(Ref(close, 5), 20)");
    expect(ast.type).toBe("call");
    if (ast.type !== "call") throw new Error("not a call");
    expect(ast.name).toBe("Mean");
    expect(ast.args.length).toBe(2);
    expect(ast.args[0]?.type).toBe("call");
    expect(ast.args[1]).toMatchObject({ type: "num", value: 20 });
  });
  test("一元负", () => {
    const ast = parse("-close + 1");
    expect(ast).toMatchObject({
      type: "binop",
      left: { type: "unary", op: "-" },
    });
  });
  test("非法 token 抛 ExprParseError", () => {
    expect(() => parse("Mean(close, )")).toThrow(ExprParseError);
  });
});

describe("Evaluator", () => {
  test("简单字段 + 标量", () => {
    const close = [1, 2, 3, 4, 5];
    const ast = parse("close + 10");
    const series = evalExpr(ast, ps(close));
    expect(series).toEqual([11, 12, 13, 14, 15]);
  });

  test("Ref 滞后", () => {
    const close = [10, 11, 12, 13, 14];
    const ast = parse("Ref(close, 2)");
    expect(evalExpr(ast, ps(close))).toEqual([null, null, 10, 11, 12]);
  });

  test("Mean 滚动均值", () => {
    const close = [1, 2, 3, 4, 5];
    const ast = parse("Mean(close, 3)");
    const r = evalExpr(ast, ps(close));
    expect(r[0]).toBeNull();
    expect(r[1]).toBeNull();
    expect(r[2]).toBe(2); // (1+2+3)/3
    expect(r[3]).toBe(3);
    expect(r[4]).toBe(4);
  });

  test("Std 滚动标准差", () => {
    const close = [1, 2, 3];
    const ast = parse("Std(close, 3)");
    const r = evalExpr(ast, ps(close));
    expect(r[2]).toBeCloseTo(1, 3); // 1, 2, 3 → mean=2，std=√((1+0+1)/2)=1
  });

  test("Delta", () => {
    const close = [10, 12, 15, 14];
    const ast = parse("Delta(close, 1)");
    const r = evalExpr(ast, ps(close));
    expect(r).toEqual([null, 2, 3, -1]);
  });

  test("典型动量因子 close / Ref(close, 20) - 1", () => {
    const close = Array.from({ length: 25 }, (_, i) => 100 + i);
    const ast = parse("close / Ref(close, 20) - 1");
    const r = evalExpr(ast, ps(close));
    expect(r[19]).toBeNull(); // 19 - 20 < 0
    expect(r[20]).toBeCloseTo(120 / 100 - 1, 4);
    expect(r[24]).toBeCloseTo(124 / 104 - 1, 4);
  });

  test("EMA", () => {
    const close = [1, 2, 3, 4, 5];
    const ast = parse("EMA(close, 3)");
    const r = evalExpr(ast, ps(close)) as number[];
    // alpha = 0.5
    expect(r[0]).toBe(1);
    expect(r[1]).toBe(1.5); // 1 + 0.5*(2-1)
    expect(r[2]).toBe(2.25);
  });

  test("Sign / Abs / Log", () => {
    const close = [-2, 0, 3, Math.E];
    expect(evalExpr(parse("Sign(close)"), ps(close))).toEqual([-1, 0, 1, 1]);
    expect(evalExpr(parse("Abs(close)"), ps(close))).toEqual([2, 0, 3, Math.E]);
    const logR = evalExpr(parse("Log(close)"), ps(close)) as Array<number | null>;
    expect(logR[0]).toBeNull(); // log(-2) → null
    expect(logR[3]).toBeCloseTo(1, 5);
  });

  test("Corr 相关系数", () => {
    const close = [1, 2, 3, 4, 5];
    const ast = parse("Corr(close, high, 5)");
    const r = evalExpr(ast, ps(close));
    // close 与 high (close*1.01) 完全线性相关
    expect(r[4]).toBeCloseTo(1, 4);
  });

  test("Slope 线性回归斜率", () => {
    const close = [1, 2, 3, 4, 5];
    const ast = parse("Slope(close, 5)");
    const r = evalExpr(ast, ps(close));
    expect(r[4]).toBeCloseTo(1, 4); // x=[0..4], y=close → 斜率 1
  });

  test("未知函数抛错", () => {
    const ast = parse("Mystery(close)");
    expect(() => evalExpr(ast, ps([1, 2, 3]))).toThrow(/unknown_op/);
  });

  test("缺值传播：close 有 null 不破坏 Mean", () => {
    const close = [1, 2, null, 4, 5] as Array<number | null>;
    const series: PriceSeries = {
      length: 5,
      fields: {
        close,
        high: close.map((c) => (c == null ? null : c * 1.01)),
        low: close.map((c) => (c == null ? null : c * 0.99)),
        open: close.map((c) => (c == null ? null : c * 0.99)),
        volume: [100, 100, 100, 100, 100],
        turnover: [100, 100, 100, 100, 100],
        vwap: close,
      },
    };
    const ast = parse("Mean(close, 3)");
    const r = evalExpr(ast, series);
    // close[2] 是 null → 窗口里只有 2 个有效值 → null
    expect(r[2]).toBeNull();
    expect(r[3]).toBeNull(); // 窗口 [2,3,4] 含 null
    expect(r[4]).toBeNull(); // 窗口 [3,4,5] 但 close[2]=null 已落出，window=close[2..4] 仍含 null
  });
});
