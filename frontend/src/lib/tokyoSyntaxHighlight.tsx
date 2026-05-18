import type { ReactNode } from "react";

export type TokyoCodeLanguage = "python" | "javascript" | "typescript" | "json" | "plaintext";

type TokenKind =
  | "keyword"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "builtin"
  | "type"
  | "operator"
  | "punctuation"
  | "property"
  | "json-key"
  | "json-bool"
  | "json-null"
  | "plain";

interface Token {
  text: string;
  kind: TokenKind;
}

const PY_KEYWORDS = new Set([
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "True",
  "try",
  "while",
  "with",
  "yield",
]);

const JS_KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

const PY_BUILTINS = new Set([
  "print",
  "len",
  "range",
  "int",
  "float",
  "str",
  "list",
  "dict",
  "set",
  "tuple",
  "bool",
  "type",
  "enumerate",
  "zip",
  "map",
  "filter",
  "sum",
  "min",
  "max",
  "abs",
  "round",
]);

function spanClass(kind: TokenKind): string {
  return `tokyo-hl-${kind}`;
}

function pushPlain(tokens: Token[], text: string) {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last?.kind === "plain") last.text += text;
  else tokens.push({ text, kind: "plain" });
}

function tokenizeLine(line: string, lang: TokyoCodeLanguage): Token[] {
  if (lang === "plaintext") return [{ text: line || " ", kind: "plain" }];

  if (lang === "json") {
    return tokenizeJsonLine(line);
  }

  const tokens: Token[] = [];
  let i = 0;
  const keywords = lang === "python" ? PY_KEYWORDS : JS_KEYWORDS;

  while (i < line.length) {
    const rest = line.slice(i);

    if (/^\s+/.test(rest)) {
      const m = rest.match(/^\s+/)!;
      pushPlain(tokens, m[0]);
      i += m[0].length;
      continue;
    }

    if (lang === "python" && rest.startsWith("#")) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }
    if ((lang === "javascript" || lang === "typescript") && rest.startsWith("//")) {
      tokens.push({ text: rest, kind: "comment" });
      break;
    }

    if (/^['"`]/.test(rest)) {
      const q = rest[0];
      let j = 1;
      while (j < rest.length) {
        if (rest[j] === "\\") {
          j += 2;
          continue;
        }
        if (rest[j] === q) {
          j += 1;
          break;
        }
        j += 1;
      }
      tokens.push({ text: rest.slice(0, j), kind: "string" });
      i += j;
      continue;
    }

    if (/^0x[0-9a-fA-F]+|^\d+\.?\d*([eE][+-]?\d+)?/.test(rest)) {
      const m = rest.match(/^0x[0-9a-fA-F]+|^\d+\.?\d*([eE][+-]?\d+)?/)!;
      tokens.push({ text: m[0], kind: "number" });
      i += m[0].length;
      continue;
    }

    if (/^[a-zA-Z_]\w*/.test(rest)) {
      const m = rest.match(/^[a-zA-Z_]\w*/)!;
      const word = m[0];
      const next = rest[m[0].length];
      if (keywords.has(word)) tokens.push({ text: word, kind: "keyword" });
      else if (lang === "python" && PY_BUILTINS.has(word)) tokens.push({ text: word, kind: "builtin" });
      else if (next === "(") tokens.push({ text: word, kind: "function" });
      else tokens.push({ text: word, kind: "plain" });
      i += word.length;
      continue;
    }

    if (/^[+\-*/%=<>!&|^~?:.,;[\]{}()]/.test(rest)) {
      const m = rest.match(/^[+\-*/%=<>!&|^~?:.,;[\]{}()]+/)!;
      tokens.push({ text: m[0], kind: "operator" });
      i += m[0].length;
      continue;
    }

    pushPlain(tokens, rest[0]!);
    i += 1;
  }

  if (tokens.length === 0) tokens.push({ text: " ", kind: "plain" });
  return tokens;
}

function tokenizeJsonLine(line: string): Token[] {
  const tokens: Token[] = [];
  const trimmed = line.trim();
  if (!trimmed) return [{ text: line || " ", kind: "plain" }];

  const keyMatch = line.match(/^(\s*)"([^"\\]|\\.)*"\s*:/);
  if (keyMatch) {
    const lead = keyMatch[1] ?? "";
    if (lead) pushPlain(tokens, lead);
    const keyPart = line.slice(lead.length).match(/^"([^"\\]|\\.)*"/);
    if (keyPart) {
      tokens.push({ text: keyPart[0], kind: "json-key" });
      pushPlain(tokens, line.slice(lead.length + keyPart[0].length));
      return tokens;
    }
  }

  if (/^\s*"/.test(line)) {
    const m = line.match(/^(\s*)"([^"\\]|\\.)*"/);
    if (m) {
      if (m[1]) pushPlain(tokens, m[1]);
      tokens.push({ text: m[0].slice(m[1]?.length ?? 0), kind: "string" });
      return tokens;
    }
  }

  if (/\btrue\b|\bfalse\b/.test(trimmed)) {
    return [{ text: line, kind: "json-bool" }];
  }
  if (/\bnull\b/.test(trimmed)) {
    return [{ text: line, kind: "json-null" }];
  }
  if (/^-?\d/.test(trimmed)) {
    return [{ text: line, kind: "number" }];
  }

  return [{ text: line || " ", kind: "plain" }];
}

export function highlightTokyoCode(code: string, language: TokyoCodeLanguage): ReactNode[] {
  const lines = code.split("\n");
  return lines.map((line, lineIndex) => (
    <span key={lineIndex} className="qb-tokyo-editor__line">
      {tokenizeLine(line, language).map((tok, ti) => (
        <span key={ti} className={spanClass(tok.kind)}>
          {tok.text || " "}
        </span>
      ))}
      {lineIndex < lines.length - 1 ? "\n" : null}
    </span>
  ));
}

export function inferTokyoLanguage(lang?: string): TokyoCodeLanguage {
  if (!lang) return "plaintext";
  const l = lang.toLowerCase().replace(/^language-/, "");
  if (l === "py" || l === "python") return "python";
  if (l === "ts" || l === "typescript") return "typescript";
  if (l === "js" || l === "javascript") return "javascript";
  if (l === "json") return "json";
  return "plaintext";
}

export function countLines(code: string): number {
  if (!code) return 1;
  return code.split("\n").length;
}

export function cursorLineCol(code: string, offset: number): { line: number; col: number } {
  const before = code.slice(0, Math.max(0, offset));
  const line = before.split("\n").length;
  const lastNl = before.lastIndexOf("\n");
  const col = lastNl === -1 ? before.length + 1 : before.length - lastNl;
  return { line, col };
}
