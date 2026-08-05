/**
 * Normalize factor expressions / lang so agent paths hit qlib_expr dry-run,
 * not a bare Python sandbox that lacks Ref/Mean.
 */

export const SUPPORTED_QLIB_OPS = [
  "Ref",
  "Mean",
  "Std",
  "Sum",
  "Max",
  "Min",
  "Rank",
  "Delay",
  "Corr",
  "Delta",
  "Abs",
  "Log",
  "EMA",
  "Slope",
  "Sign",
  "IfPos",
] as const;

/** Rewrite common LLM aliases into qlib_expr operators. */
export function normalizeFactorExpression(expr: string): {
  expr: string;
  rewrites: string[];
  unsupported: string[];
} {
  let next = expr.trim();
  const rewrites: string[] = [];
  const unsupported: string[] = [];

  const shiftRe = /\bshift\s*\(/gi;
  if (shiftRe.test(next)) {
    next = next.replace(/\bshift\s*\(/gi, "Ref(");
    rewrites.push("shift→Ref");
  }
  const delayRe = /\bdelay\s*\(/gi;
  if (delayRe.test(next)) {
    next = next.replace(/\bdelay\s*\(/gi, "Ref(");
    rewrites.push("delay→Ref");
  }

  // Dry-run series is finite; clamp huge lookbacks (e.g. 252) so register can succeed.
  next = next.replace(/\bRef\s*\(\s*([^,]+?)\s*,\s*(\d+)\s*\)/gi, (_m, series: string, raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 80) {
      rewrites.push(`Ref(${n})→Ref(21)`);
      return `Ref(${String(series).trim()}, 21)`;
    }
    return `Ref(${String(series).trim()}, ${raw})`;
  });

  // Flag clearly-python-only names that qlib won't define.
  for (const name of ["pd", "np", "pandas", "numpy", "DataFrame"]) {
    if (new RegExp(`\\b${name}\\b`).test(next)) {
      unsupported.push(name);
    }
  }

  return { expr: next, rewrites, unsupported };
}

export function inferFactorLang(expr: string, explicit?: string | null): "qlib_expr" | "python" {
  if (explicit === "python" || explicit === "qlib_expr") return explicit;
  // Agent default: qlib_expr. Only force python when clearly a script body.
  if (/^\s*(import|from|def|class)\b/m.test(expr) || /\bfactor_values\s*=/.test(expr)) {
    return "python";
  }
  return "qlib_expr";
}

export function formatUnsupportedExpressionError(input: {
  expr: string;
  reason: string;
  rewrites?: string[];
}): string {
  const ops = SUPPORTED_QLIB_OPS.join(", ");
  const rewriteNote =
    input.rewrites && input.rewrites.length > 0
      ? ` 已尝试改写: ${input.rewrites.join(", ")}。`
      : "";
  return (
    `unsupported_expression: ${input.reason}.${rewriteNote} ` +
    `请使用 qlib_expr 算子（${ops}），例如: close / Ref(close, 21) - 1。` +
    ` 原始表达式: ${input.expr}`
  );
}
