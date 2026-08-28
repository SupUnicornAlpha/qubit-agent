/**
 * 代码符号大纲解析器 (Code Symbol Outline Parser)
 * 为 Python / TypeScript / JavaScript / JSON / Markdown / SQL 等策略文件
 * 快速提取函数、类、类型、顶级配置与标题符号，供大纲树与面包屑导航使用。
 */

export type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "variable"
  | "heading"
  | "property"
  | "table"
  | "decorator";

export interface CodeOutlineSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  detail?: string;
  children?: CodeOutlineSymbol[];
}

export function parseCodeOutline(code: string, filename: string): CodeOutlineSymbol[] {
  if (!code || !code.trim()) return [];
  const ext = (filename.includes(".") ? filename.split(".").pop() : "")?.toLowerCase() || "";
  const lines = code.split(/\r?\n/);

  switch (ext) {
    case "py":
      return parsePythonOutline(lines);
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return parseTsJsOutline(lines);
    case "md":
    case "markdown":
      return parseMarkdownOutline(lines);
    case "json":
      return parseJsonOutline(lines);
    case "sql":
      return parseSqlOutline(lines);
    default:
      return parseGenericOutline(lines);
  }
}

function parsePythonOutline(lines: string[]): CodeOutlineSymbol[] {
  const symbols: CodeOutlineSymbol[] = [];
  const stack: { symbol: CodeOutlineSymbol; indent: number }[] = [];

  const classRegex = /^\s*class\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s*\((.*?)\))?\s*:/;
  const defRegex = /^\s*(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*?)\)\s*(?:->\s*(.*?))?\s*:/;
  const topVarRegex = /^([A-Z_][A-Z0-9_]*)\s*[:=]/;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;

    const indent = rawLine.search(/\S/);
    if (indent === -1) continue;

    const classMatch = rawLine.match(classRegex);
    if (classMatch) {
      const name = classMatch[1]!;
      const baseClass = classMatch[2] ? `(${classMatch[2]})` : "";
      const symbol: CodeOutlineSymbol = {
        id: `py-class-${i}-${name}`,
        name,
        kind: "class",
        line: i + 1,
        column: indent + 1,
        detail: baseClass,
        children: [],
      };

      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
        stack.pop();
      }

      if (stack.length > 0) {
        stack[stack.length - 1]!.symbol.children?.push(symbol);
      } else {
        symbols.push(symbol);
      }
      stack.push({ symbol, indent });
      continue;
    }

    const defMatch = rawLine.match(defRegex);
    if (defMatch) {
      const name = defMatch[1]!;
      const params = defMatch[2]?.trim() || "";
      const returnType = defMatch[3]?.trim() ? ` -> ${defMatch[3].trim()}` : "";
      const isMethod = stack.length > 0 && stack[stack.length - 1]!.symbol.kind === "class";
      const symbol: CodeOutlineSymbol = {
        id: `py-def-${i}-${name}`,
        name,
        kind: isMethod ? "method" : "function",
        line: i + 1,
        column: indent + 1,
        detail: `(${params})${returnType}`,
        children: [],
      };

      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
        stack.pop();
      }

      if (stack.length > 0) {
        stack[stack.length - 1]!.symbol.children?.push(symbol);
      } else {
        symbols.push(symbol);
      }
      stack.push({ symbol, indent });
      continue;
    }

    const varMatch = rawLine.match(topVarRegex);
    if (varMatch && indent === 0) {
      const name = varMatch[1]!;
      symbols.push({
        id: `py-var-${i}-${name}`,
        name,
        kind: "variable",
        line: i + 1,
        column: 1,
      });
    }
  }

  return symbols;
}

function parseTsJsOutline(lines: string[]): CodeOutlineSymbol[] {
  const symbols: CodeOutlineSymbol[] = [];
  const funcRegex = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/;
  const arrowRegex = /^\s*(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*:\s*[^=]+)?\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z0-9_$]+)\s*=>/;
  const classRegex = /^\s*(?:export\s+)?(?:default\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/;
  const interfaceRegex = /^\s*(?:export\s+)?interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/;
  const typeRegex = /^\s*(?:export\s+)?type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/;
  const enumRegex = /^\s*(?:export\s+)?enum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const indent = rawLine.search(/\S/);
    if (indent === -1 || rawLine.trim().startsWith("//") || rawLine.trim().startsWith("/*")) continue;

    let m = rawLine.match(classRegex);
    if (m) {
      symbols.push({
        id: `ts-class-${i}-${m[1]}`,
        name: m[1]!,
        kind: "class",
        line: i + 1,
        column: indent + 1,
      });
      continue;
    }

    m = rawLine.match(funcRegex);
    if (m) {
      symbols.push({
        id: `ts-func-${i}-${m[1]}`,
        name: m[1]!,
        kind: "function",
        line: i + 1,
        column: indent + 1,
      });
      continue;
    }

    m = rawLine.match(arrowRegex);
    if (m) {
      symbols.push({
        id: `ts-arrow-${i}-${m[1]}`,
        name: m[1]!,
        kind: "function",
        line: i + 1,
        column: indent + 1,
      });
      continue;
    }

    m = rawLine.match(interfaceRegex);
    if (m) {
      symbols.push({
        id: `ts-intf-${i}-${m[1]}`,
        name: m[1]!,
        kind: "interface",
        line: i + 1,
        column: indent + 1,
      });
      continue;
    }

    m = rawLine.match(typeRegex);
    if (m) {
      symbols.push({
        id: `ts-type-${i}-${m[1]}`,
        name: m[1]!,
        kind: "type",
        line: i + 1,
        column: indent + 1,
      });
      continue;
    }

    m = rawLine.match(enumRegex);
    if (m) {
      symbols.push({
        id: `ts-enum-${i}-${m[1]}`,
        name: m[1]!,
        kind: "type",
        line: i + 1,
        column: indent + 1,
      });
    }
  }

  return symbols;
}

function parseMarkdownOutline(lines: string[]): CodeOutlineSymbol[] {
  const symbols: CodeOutlineSymbol[] = [];
  const headingRegex = /^(#{1,6})\s+(.*)$/;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const m = rawLine.match(headingRegex);
    if (m) {
      const level = m[1]!.length;
      const title = m[2]!.trim();
      symbols.push({
        id: `md-h${level}-${i}`,
        name: title,
        kind: "heading",
        line: i + 1,
        column: 1,
        detail: `H${level}`,
      });
    }
  }
  return symbols;
}

function parseJsonOutline(lines: string[]): CodeOutlineSymbol[] {
  const symbols: CodeOutlineSymbol[] = [];
  const keyRegex = /^\s*"([^"]+)"\s*:\s*([{\[]?)/;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const indent = rawLine.search(/\S/);
    if (indent <= 4 && indent >= 0) {
      const m = rawLine.match(keyRegex);
      if (m) {
        symbols.push({
          id: `json-key-${i}-${m[1]}`,
          name: m[1]!,
          kind: "property",
          line: i + 1,
          column: indent + 1,
          detail: m[2] ? (m[2] === "{" ? "Object" : "Array") : undefined,
        });
      }
    }
  }
  return symbols;
}

function parseSqlOutline(lines: string[]): CodeOutlineSymbol[] {
  const symbols: CodeOutlineSymbol[] = [];
  const tableRegex = /^\s*CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"']?[a-zA-Z0-9_]+[`"']?)/i;
  const indexRegex = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"']?[a-zA-Z0-9_]+[`"']?)/i;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    let m = rawLine.match(tableRegex);
    if (m) {
      symbols.push({
        id: `sql-table-${i}-${m[1]}`,
        name: m[1]!.replace(/[`"']/g, ""),
        kind: "table",
        line: i + 1,
        column: 1,
        detail: "TABLE",
      });
      continue;
    }
    m = rawLine.match(indexRegex);
    if (m) {
      symbols.push({
        id: `sql-index-${i}-${m[1]}`,
        name: m[1]!.replace(/[`"']/g, ""),
        kind: "property",
        line: i + 1,
        column: 1,
        detail: "INDEX",
      });
    }
  }
  return symbols;
}

function parseGenericOutline(lines: string[]): CodeOutlineSymbol[] {
  const symbols: CodeOutlineSymbol[] = [];
  const genericRegex = /^(?:def|class|function|struct|fn|pub fn)\s+([a-zA-Z_][a-zA-Z0-9_]*)/;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const m = rawLine.match(genericRegex);
    if (m) {
      symbols.push({
        id: `gen-${i}-${m[1]}`,
        name: m[1]!,
        kind: "function",
        line: i + 1,
        column: 1,
      });
    }
  }
  return symbols;
}
