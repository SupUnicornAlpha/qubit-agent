import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPythonBin } from "../sandbox/python-runtime";
import type { MathNumericEvaluator, MathSymbolicVerifier } from "./math-reasoning";

const RUNNER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../python_connectors/math_verifier_runner.py"
);
const TIMEOUT_MS = 12_000;

type RunnerResponse = {
  ok: boolean;
  value?: number | boolean;
  equivalent?: boolean;
  unavailable?: boolean;
  engine_version?: string;
  error?: string;
};

async function runMathVerifier(payload: Record<string, unknown>): Promise<RunnerResponse> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([getPythonBin(), "-I", RUNNER_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    return {
      ok: false,
      error: `python_unavailable:${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const stdin = proc.stdin as { write(value: string): void; end(): void };
  stdin.write(JSON.stringify(payload));
  stdin.end();
  const work = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timeoutId = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
  });
  const outcome = await Promise.race([work, timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (outcome === "timeout") {
    try {
      proc.kill();
    } catch {
      // best-effort cleanup
    }
    return { ok: false, error: "python_timeout" };
  }
  const [stdout, stderr, exitCode] = outcome;
  try {
    const parsed = JSON.parse(stdout.trim()) as RunnerResponse;
    return parsed;
  } catch {
    return { ok: false, error: `python_exit_${exitCode}:${stderr.trim().slice(0, 300)}` };
  }
}

/**
 * A fixed AST-verifier, not arbitrary model Python. It can safely be used as
 * the baseline numerical oracle even when optional mathjs/SymPy are absent.
 */
export const pythonMathNumericEvaluator: MathNumericEvaluator = {
  id: "python-ast",
  async evaluate(input) {
    const result = await runMathVerifier({ action: "evaluate", ...input });
    if (!result.ok || result.value === undefined)
      return { ok: false, error: result.error ?? "python_math_failed" };
    return {
      ok: true,
      value: result.value,
      ...(result.engine_version ? { engineVersion: result.engine_version } : {}),
    };
  },
};

/** SymPy is optional: unavailability becomes an auditable skipped check. */
export const pythonSympyVerifier: MathSymbolicVerifier = {
  id: "sympy",
  async equivalent(input) {
    const result = await runMathVerifier({
      action: "symbolic_equivalent",
      left_expression: input.leftExpression,
      right_expression: input.rightExpression,
      variables: input.variables,
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "sympy_failed",
        ...(result.unavailable ? { unavailable: true } : {}),
      };
    }
    return {
      ok: true,
      equivalent: result.equivalent === true,
      ...(result.engine_version ? { engineVersion: result.engine_version } : {}),
    };
  },
};
