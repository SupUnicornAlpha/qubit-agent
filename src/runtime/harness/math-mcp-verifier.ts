import { dispatchMcpToolCall } from "../mcp/dispatcher";
import type { MathNumericEvaluator } from "./math-reasoning";

function substituteVariables(expression: string, variables: Record<string, number>): string {
  let output = expression;
  for (const [name, value] of Object.entries(variables)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || !Number.isFinite(value)) {
      throw new Error(`invalid_mathjs_variable:${name}`);
    }
    output = output.replace(new RegExp(`\\b${name}\\b`, "g"), `(${value})`);
  }
  return output;
}

function parseScalar(value: unknown, depth = 0): number | boolean | null {
  if (depth > 4) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "true") return true;
    if (text === "false") return false;
    const number = Number(text);
    if (Number.isFinite(number)) return number;
    try {
      return parseScalar(JSON.parse(text), depth + 1);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["value", "result", "output", "text", "content"]) {
    const parsed = parseScalar(record[key], depth + 1);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Optional mathjs MCP adapter; callers should pair it with the Python fallback. */
export function createMathjsNumericEvaluator(input: {
  projectId?: string;
  definitionId: string;
}): MathNumericEvaluator {
  return {
    id: "mathjs-mcp",
    async evaluate({ expression, variables }) {
      try {
        const response = await dispatchMcpToolCall({
          ...(input.projectId ? { projectId: input.projectId } : {}),
          definitionId: input.definitionId,
          serverName: "mathjs",
          toolName: "evaluate",
          arguments: { expression: substituteVariables(expression, variables) },
        });
        const value = parseScalar(response.output);
        return value === null
          ? { ok: false, error: "mathjs_non_scalar_result" }
          : { ok: true, value, engineVersion: "mathjs-mcp" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

export function withNumericFallback(
  primary: MathNumericEvaluator,
  fallback: MathNumericEvaluator
): MathNumericEvaluator {
  return {
    id: `${primary.id}->${fallback.id}`,
    async evaluate(input) {
      const preferred = await primary.evaluate(input);
      if (preferred.ok) return preferred;
      const alternative = await fallback.evaluate(input);
      return alternative.ok
        ? {
            ...alternative,
            engineVersion: `${alternative.engineVersion ?? fallback.id}; fallback_from=${primary.id}`,
          }
        : {
            ok: false,
            error: `${primary.id}:${preferred.error}; ${fallback.id}:${alternative.error}`,
          };
    },
  };
}
