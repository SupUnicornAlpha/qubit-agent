const DATA_TOOL_PATTERN =
  /(fetch|get_quote|get_price|get_market_news|get_financial|get_fundamental|get_earnings|klines|bars|news)/i;

export function detectSemanticToolFailure(toolName: string, value: unknown): string | null {
  if (!DATA_TOOL_PATTERN.test(toolName)) return null;
  const payload = unwrap(value);
  if (Array.isArray(payload) && payload.length === 0) return "semantic_empty_result";
  return inspect(payload, 0);
}

function unwrap(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.connectorResult !== undefined) return record.connectorResult;
  if (record.mcpResult && typeof record.mcpResult === "object") {
    return (record.mcpResult as Record<string, unknown>).output;
  }
  if (record.builtinResult !== undefined) return record.builtinResult;
  return value;
}

function inspect(value: unknown, depth: number): string | null {
  if (depth > 5 || value == null) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return "semantic_empty_result";
    const failures = value.map((item) => inspect(item, depth + 1)).filter(Boolean);
    return failures.length === value.length ? (failures[0] ?? null) : null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.error === "no_bars" || record.error === "no_data") return String(record.error);
  if (record.barCount === 0) return "bar_count_zero";
  for (const key of ["bars", "periods", "items", "quotes", "news", "rows"]) {
    const nested = record[key];
    if (Array.isArray(nested) && nested.length === 0) return `${key}_empty`;
  }
  for (const nested of Object.values(record)) {
    const failure = inspect(nested, depth + 1);
    if (failure) return failure;
  }
  return null;
}
