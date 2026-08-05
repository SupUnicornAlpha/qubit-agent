/**
 * 大工具结果展示：pretty JSON 截断，避免上万行数组把中栏/对话卡死。
 */

export type JsonPreviewOptions = {
  maxChars?: number;
  maxLines?: number;
  /** 数组过长时只保留前 N 项再 stringify */
  maxArrayItems?: number;
};

export type JsonPreviewResult = {
  text: string;
  truncated: boolean;
  charCount: number;
  lineCount: number;
};

const DEFAULTS = {
  maxChars: 6_000,
  maxLines: 120,
  maxArrayItems: 24,
} as const;

function shrinkForPreview(value: unknown, maxArrayItems: number, depth = 0): unknown {
  if (depth > 8) return "[…]";
  if (Array.isArray(value)) {
    if (value.length <= maxArrayItems) {
      return value.map((item) => shrinkForPreview(item, maxArrayItems, depth + 1));
    }
    const head = value
      .slice(0, maxArrayItems)
      .map((item) => shrinkForPreview(item, maxArrayItems, depth + 1));
    return [
      ...head,
      {
        __truncated: true,
        omitted: value.length - maxArrayItems,
        total: value.length,
      },
    ];
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shrinkForPreview(v, maxArrayItems, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2_000) {
    return `${value.slice(0, 2_000)}…(+${value.length - 2_000} chars)`;
  }
  return value;
}

function stringifySafe(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") {
    const t = value.trim();
    if (
      (t.startsWith("{") && t.endsWith("}")) ||
      (t.startsWith("[") && t.endsWith("]"))
    ) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 生成可安全塞进 `<pre>` 的预览文本；过大则截断并标注。 */
export function formatLargeJsonPreview(
  value: unknown,
  opts?: JsonPreviewOptions
): JsonPreviewResult {
  const maxChars = opts?.maxChars ?? DEFAULTS.maxChars;
  const maxLines = opts?.maxLines ?? DEFAULTS.maxLines;
  const maxArrayItems = opts?.maxArrayItems ?? DEFAULTS.maxArrayItems;

  const needsShrink = valueNeedsShrink(value, maxArrayItems);
  const source = needsShrink ? shrinkForPreview(value, maxArrayItems) : value;
  let text = stringifySafe(source);
  const fullLen = text.length;
  let truncated = needsShrink;

  const lines = text.split("\n");
  if (lines.length > maxLines) {
    text = `${lines.slice(0, maxLines).join("\n")}\n…(+${lines.length - maxLines} lines)`;
    truncated = true;
  }
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…(+${Math.max(0, fullLen - maxChars)} chars)`;
    truncated = true;
  }

  return {
    text,
    truncated,
    charCount: fullLen,
    lineCount: lines.length,
  };
}

function valueNeedsShrink(value: unknown, maxArrayItems: number, depth = 0): boolean {
  if (depth > 8) return true;
  if (typeof value === "string") return value.length > 2_000;
  if (Array.isArray(value)) {
    if (value.length > maxArrayItems) return true;
    return value.some((item) => valueNeedsShrink(item, maxArrayItems, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) =>
      valueNeedsShrink(v, maxArrayItems, depth + 1)
    );
  }
  return false;
}

/** 复制完整原始 JSON（不截断）。 */
export function stringifyJsonFull(value: unknown): string {
  return stringifySafe(value);
}

export function estimateJsonSizeLabel(value: unknown): string {
  try {
    const n = JSON.stringify(value)?.length ?? 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  } catch {
    return "—";
  }
}
