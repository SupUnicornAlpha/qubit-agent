/**
 * Qlib-like expression parser
 *
 * 文法（精简版，与 Pratt 表达式风格一致）：
 *   expr   := term (('+'|'-') term)*
 *   term   := factor (('*'|'/') factor)*
 *   factor := '-' factor
 *           | number
 *           | ident ('(' arglist? ')')?
 *           | '(' expr ')'
 *   arglist := expr (',' expr)*
 */

import { tokenize, type Token } from "./lexer";

export type Ast =
  | { type: "num"; value: number }
  | { type: "field"; name: string }
  | { type: "binop"; op: "+" | "-" | "*" | "/"; left: Ast; right: Ast }
  | { type: "unary"; op: "-"; operand: Ast }
  | { type: "call"; name: string; args: Ast[] };

export class ExprParseError extends Error {
  constructor(
    public pos: number,
    message: string
  ) {
    super(`parse_error@${pos}: ${message}`);
    this.name = "ExprParseError";
  }
}

class Parser {
  private i = 0;
  constructor(private toks: Token[]) {}

  private peek(): Token {
    return this.toks[this.i]!;
  }
  private consume(): Token {
    return this.toks[this.i++]!;
  }
  private expect(type: Token["type"], value?: string): Token {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ExprParseError(
        t.pos,
        `expected ${type}${value ? `(${value})` : ""}, got ${t.type}(${t.value})`
      );
    }
    return this.consume();
  }

  parseExpr(): Ast {
    let left = this.parseTerm();
    while (true) {
      const t = this.peek();
      if (t.type === "op" && (t.value === "+" || t.value === "-")) {
        this.consume();
        const right = this.parseTerm();
        left = { type: "binop", op: t.value as "+" | "-", left, right };
      } else {
        break;
      }
    }
    return left;
  }

  parseTerm(): Ast {
    let left = this.parseFactor();
    while (true) {
      const t = this.peek();
      if (t.type === "op" && (t.value === "*" || t.value === "/")) {
        this.consume();
        const right = this.parseFactor();
        left = { type: "binop", op: t.value as "*" | "/", left, right };
      } else {
        break;
      }
    }
    return left;
  }

  parseFactor(): Ast {
    const t = this.peek();
    if (t.type === "op" && t.value === "-") {
      this.consume();
      return { type: "unary", op: "-", operand: this.parseFactor() };
    }
    if (t.type === "number") {
      this.consume();
      return { type: "num", value: Number(t.value) };
    }
    if (t.type === "lparen") {
      this.consume();
      const e = this.parseExpr();
      this.expect("rparen");
      return e;
    }
    if (t.type === "ident") {
      this.consume();
      const next = this.peek();
      if (next.type === "lparen") {
        // 函数调用
        this.consume();
        const args: Ast[] = [];
        if (this.peek().type !== "rparen") {
          args.push(this.parseExpr());
          while (this.peek().type === "comma") {
            this.consume();
            args.push(this.parseExpr());
          }
        }
        this.expect("rparen");
        return { type: "call", name: t.value, args };
      }
      /**
       * Strip qlib 标准字段前缀 `$`：`$close` → field "close"。lexer 已接受
       * `$` 作 ident 首字符（见 lexer.ts:isIdentStart 注释），这里把它归一化
       * 成裸字段名，evaluator 不用关心两种写法。
       */
      const name = t.value.startsWith("$") ? t.value.slice(1) : t.value;
      return { type: "field", name };
    }
    throw new ExprParseError(t.pos, `unexpected_token: ${t.type}(${t.value})`);
  }
}

export function parse(input: string): Ast {
  const toks = tokenize(input);
  const p = new Parser(toks);
  const ast = p.parseExpr();
  // 验证 EOF
  if (toks[toks.length - 1]!.type !== "eof") {
    // 不应发生
    throw new ExprParseError(0, "internal_lexer_error");
  }
  return ast;
}
