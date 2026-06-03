/**
 * Qlib-like expression lexer
 *
 * 支持语法：
 *   字段：close, open, high, low, volume, vwap
 *   常量：123, 0.5, -1
 *   函数：Ref(close, 5), Mean(close, 20), Std(close, 20), ...
 *   运算：+ - * / ( ) ,
 *   嵌套：Mean(Ref(close, 5), 20)
 *
 * 不支持：字符串字面量、变量、控制流、属性访问（保持表达式纯净）
 */

export type TokenType =
  | "number"
  | "ident"
  | "lparen"
  | "rparen"
  | "comma"
  | "op"
  | "eof";

export interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const SINGLE_CHAR_OPS = new Set(["+", "-", "*", "/"]);

export class ExprLexError extends Error {
  constructor(
    public pos: number,
    message: string
  ) {
    super(`lex_error@${pos}: ${message}`);
    this.name = "ExprLexError";
  }
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i]!;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen", value: "(", pos: i });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ")", pos: i });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ",", pos: i });
      i++;
      continue;
    }

    if (SINGLE_CHAR_OPS.has(ch)) {
      tokens.push({ type: "op", value: ch, pos: i });
      i++;
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(input[i + 1] ?? ""))) {
      let j = i;
      let seenDot = ch === ".";
      j++;
      while (j < n) {
        const c = input[j]!;
        if (isDigit(c)) {
          j++;
        } else if (c === "." && !seenDot) {
          seenDot = true;
          j++;
        } else {
          break;
        }
      }
      tokens.push({ type: "number", value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentCont(input[j]!)) j++;
      tokens.push({ type: "ident", value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    throw new ExprLexError(i, `unexpected_char: ${JSON.stringify(ch)}`);
  }

  tokens.push({ type: "eof", value: "", pos: n });
  return tokens;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
/**
 * `$` 作为 ident 首字符接受（评估报告 P3：qlib 字段标准前缀 `$close` / `$open` /
 * `$volume` 等。之前 lexer 直接抛 `unexpected_char: "$"`，导致 LLM 按 qlib 标准
 * 写 `Mean($close, 20) - Mean($close, 60)` 在 register dry-run 就被拒，
 * 暴露在 quant-builtin-tools.test.ts 的 factor.register + factor.list 用例）。
 *
 * Parser 端会 strip 前导 `$` 取 field name，evaluator 不变 → 向后兼容
 * 「裸字段」`close` / `open` 写法。
 */
function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
}
function isIdentCont(c: string): boolean {
  return (
    (c >= "a" && c <= "z") ||
    (c >= "A" && c <= "Z") ||
    c === "_" ||
    isDigit(c)
  );
}
