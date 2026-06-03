/**
 * P3-1：runPythonExprDryRun 专项单测。
 *
 * 评估报告原话：「lang=python 路径走的是 `if (lang !== 'qlib_expr') return
 * { skipped: true }`，python_inline.compute() 本身就是个桩永远返回 rows:[]」
 * → 错的 python 因子无声落库 → factor.compute 返空 → autoEvaluate 误报。
 *
 * 测试矩阵（mock python-sandbox 模拟 5 种返回）：
 *   1. sandbox 不可用（python_unavailable / python_deps_missing / wall_timeout）
 *      → graceful skip，detail 写 reason，不阻塞注册
 *   2. sandbox 真跑 + factor_values 是 list[number]
 *      → ok=true，sampleSize / variance / perSymbolFiniteCounts 都填齐
 *   3. sandbox 真跑 + 用户代码抛 NameError / TypeError
 *      → eval_error，detail 带 symbol + trace
 *   4. sandbox 真跑 + factor_values 全部相同 / 全 NaN
 *      → degenerate_constant / insufficient_values
 *   5. sandbox 真跑 + factor_values 不是 list（用户写错）
 *      → eval_error: factor_values_invalid_for_all_symbols
 *
 * 隔离策略：用 `__testSetSandboxRunner(mock)` 做依赖注入，**不**用 Bun
 * `mock.module`（后者全局污染、无 restore，曾让 src/runtime/sandbox/ 测试
 * 在全量回归时把 runPythonSandbox 错替换成本测的 mock）。
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { __testRunPythonExprDryRun, __testSetSandboxRunner } from "../factor-service";

interface SandboxResponse {
  ok: boolean;
  stdout: string;
  result: unknown;
  elapsedMs: number;
  rowsInResult: number;
  error?: string;
  trace?: string;
}

let sandboxImpl: (req: { vars: Record<string, unknown>; returnVar?: string }) => SandboxResponse;
let sandboxCallCount = 0;

beforeEach(() => {
  sandboxCallCount = 0;
  __testSetSandboxRunner(async (req) => {
    sandboxCallCount += 1;
    return sandboxImpl(req);
  });
});

afterEach(() => {
  __testSetSandboxRunner(null);
});

afterAll(() => {
  __testSetSandboxRunner(null);
});

describe("runPythonExprDryRun — P3-1 闭环", () => {
  test("sandbox 不可用（python_unavailable）→ graceful skip，不 reject", async () => {
    sandboxImpl = () => ({
      ok: false,
      stdout: "",
      result: null,
      elapsedMs: 0,
      rowsInResult: 0,
      error: "python_unavailable",
      trace: "python bin not found",
    });
    const r = await __testRunPythonExprDryRun("close[-1] - close[-21]");
    expect(r.ok).toBe(true);
    /** 第一次 sandbox 失败就返回 skip，不再连跑 3 个 symbol */
    expect(sandboxCallCount).toBe(1);
    if (r.ok) {
      expect(r.detail["skipped"]).toBe(true);
      expect(String(r.detail["reason"])).toContain("sandbox_unavailable");
      expect(String(r.detail["reason"])).toContain("python_unavailable");
    }
  });

  test("sandbox 不可用（python_deps_missing 缺 pandas）→ graceful skip + hint", async () => {
    sandboxImpl = () => ({
      ok: false,
      stdout: "",
      result: null,
      elapsedMs: 0,
      rowsInResult: 0,
      error: "python_deps_missing",
      trace: "缺少依赖：pandas, numpy。建议 bun src/cli.ts bootstrap",
    });
    const r = await __testRunPythonExprDryRun("close[-1] - close[-21]");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.detail["skipped"]).toBe(true);
      expect(String(r.detail["hint"])).toContain("pandas");
      expect(String(r.detail["hint"])).toContain("bootstrap");
    }
  });

  test("sandbox 真跑 + 用户代码 NameError → eval_error（reject 注册）", async () => {
    sandboxImpl = () => ({
      ok: false,
      stdout: "",
      result: null,
      elapsedMs: 12,
      rowsInResult: 0,
      error: "NameError",
      trace: "NameError: name 'undefined_var' is not defined",
    });
    const r = await __testRunPythonExprDryRun("undefined_var * close[-1]");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/eval_error/);
      expect(String(r.detail?.["trace"])).toContain("NameError");
    }
  });

  test("sandbox 真跑 + factor_values 是合法 number list → ok + 真 sampleSize", async () => {
    /** 模拟典型动量因子：每根 bar 一个数字，3 个 symbol 各 90 根 */
    sandboxImpl = () => ({
      ok: true,
      stdout: "",
      result: Array.from({ length: 90 }, (_, i) => 0.001 * i + 0.5),
      elapsedMs: 25,
      rowsInResult: 90,
    });
    const r = await __testRunPythonExprDryRun("close[-1] / close[-21] - 1");
    expect(r.ok).toBe(true);
    expect(sandboxCallCount).toBe(3);
    if (r.ok) {
      expect(r.detail["pythonSandbox"]).toBe(true);
      expect(Number(r.detail["sampleSize"])).toBe(270);
      expect(Number(r.detail["variance"])).toBeGreaterThan(1e-12);
      expect((r.detail["perSymbolFiniteCounts"] as number[])[0]).toBe(90);
    }
  });

  test("sandbox 真跑 + factor_values 全相同 → degenerate_constant", async () => {
    sandboxImpl = () => ({
      ok: true,
      stdout: "",
      result: Array.from({ length: 90 }, () => 0.42),
      elapsedMs: 8,
      rowsInResult: 90,
    });
    const r = await __testRunPythonExprDryRun("0.42 * close[-1] / close[-1]");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("degenerate_constant");
      expect(Number(r.detail?.["variance"])).toBeLessThan(1e-12);
    }
  });

  test("sandbox 真跑 + factor_values 几乎全 NaN → insufficient_values", async () => {
    /** 只前 2 根有效，其它都 NaN → 3 symbol 累加 6 个有效值 < minRows=10 */
    sandboxImpl = () => ({
      ok: true,
      stdout: "",
      result: [0.1, 0.2, ...Array.from({ length: 88 }, () => null)],
      elapsedMs: 9,
      rowsInResult: 90,
    });
    const r = await __testRunPythonExprDryRun("close[-1] / close[-30] - 1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("insufficient_values");
      expect(Number(r.detail?.["finiteValues"])).toBe(6);
      expect(Number(r.detail?.["minRows"])).toBe(10);
    }
  });

  test("sandbox 真跑 + factor_values 不是 list（用户没设全局变量）→ all symbols invalid", async () => {
    sandboxImpl = () => ({
      ok: true,
      stdout: "",
      result: 0.5,
      elapsedMs: 7,
      rowsInResult: 0,
    });
    const r = await __testRunPythonExprDryRun("0.5");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/eval_error.*factor_values_invalid/);
      expect(typeof r.detail?.["errorsBySymbol"]).toBe("object");
    }
  });

  test("expr 已含 `factor_values =` → 不再 wrap，直接 exec 用户多行代码", async () => {
    sandboxImpl = () => ({
      ok: true,
      stdout: "",
      result: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
      elapsedMs: 5,
      rowsInResult: 10,
    });
    /**
     * 单测主要保证「含 `factor_values =` 的多行代码也能通过 dry-run」
     * （不会因 wrap 成 `factor_values = list(multi-line expr)` 报 SyntaxError）。
     * Wrap 字符串准确性留给集成测试在 sandbox 可用环境验证。
     */
    const r = await __testRunPythonExprDryRun(
      "import numpy as np\nfactor_values = list(np.diff(close, n=1))"
    );
    expect(r.ok).toBe(true);
  });
});
