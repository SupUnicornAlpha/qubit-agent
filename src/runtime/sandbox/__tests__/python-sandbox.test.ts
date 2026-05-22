/**
 * Python 沙箱 — 行为契约测试
 *
 * 沙箱启动期会 fail-fast 检查 python + pandas/numpy（见 python-runtime.ts）。
 * 测试以"能否真正跑起来"为准：缺解释器/缺依赖时跳过依赖型 case，但仍验证
 * fail-fast 的错误码（python_unavailable / python_deps_missing）符合契约。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { runPythonSandbox } from "../python-sandbox";
import { _resetPythonHealthCache, checkPythonHealth } from "../python-runtime";

let pythonHealthy = false;
let skipReason = "";

beforeAll(async () => {
  _resetPythonHealthCache();
  const health = await checkPythonHealth({ force: true });
  pythonHealthy = health.ok;
  skipReason = health.errorCode ?? "";
  if (!pythonHealthy) {
    console.warn(`[skip] python sandbox not healthy: ${skipReason} ${health.hint ?? ""}`);
  }
});

/** 解释器或必备依赖（pandas/numpy）任一缺失时跳过；用于"需要真实运行用户代码"的 case */
function skipIfUnhealthy(): boolean {
  return !pythonHealthy;
}

describe("Python 沙箱 — 基础执行", () => {
  test("简单求和 + return_var", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({
      code: "result = sum(vars['nums'])",
      vars: { nums: [1, 2, 3, 4, 5] },
      returnVar: "result",
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(15);
  });

  test("print → stdout 被捕获", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({
      code: "print('hello'); print(42)",
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("hello");
    expect(r.stdout).toContain("42");
  });

  test("vars 顶级展开：可直接用 bars 而非 vars['bars']", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({
      code: "result = len(bars)",
      vars: { bars: [{}, {}, {}] },
      returnVar: "result",
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(3);
  });
});

describe("Python 沙箱 — 安全限制", () => {
  test("禁止 import os", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({ code: "import os" });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/not allowed|os/i);
  });

  test("禁止 import subprocess", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({ code: "import subprocess" });
    expect(r.ok).toBe(false);
  });

  test("禁止 import socket", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({ code: "import socket" });
    expect(r.ok).toBe(false);
  });

  test("禁止 open()（不在受限 builtins 里）", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({ code: "open('/etc/passwd')" });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/open|not defined/i);
  });

  test("禁止 eval / exec（不在受限 builtins 里）", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({ code: "eval('1+1')" });
    expect(r.ok).toBe(false);
  });

  test("放行 import math / numpy（如装了）", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({
      code: "import math\nresult = math.sqrt(16)",
      returnVar: "result",
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(4);
  });
});

describe("Python 沙箱 — 超时", () => {
  test("超时被 SIGALRM 中断（用 1s 上限）", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({
      code: "x = 0\nwhile True:\n    x += 1",
      timeoutSec: 1,
    });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/timeout/i);
  });
});

describe("Python 沙箱 — 结果序列化", () => {
  test("pandas DataFrame → records", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({
      code: `
import pandas as pd
result = pd.DataFrame([{'a': 1, 'b': 2}, {'a': 3, 'b': 4}])
`,
      returnVar: "result",
    });
    if (!r.ok && /pandas/i.test(r.error ?? "")) {
      console.warn("[skip] pandas not installed");
      return;
    }
    expect(r.ok).toBe(true);
    expect((r.result as { _type: string })._type).toBe("DataFrame");
    expect((r.result as { rows: unknown[] }).rows).toHaveLength(2);
  });

  test("纯字典 / 数组 → JSON", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({
      code: "result = {'k': [1, 2, 3], 'm': 'x'}",
      returnVar: "result",
    });
    expect(r.ok).toBe(true);
    expect((r.result as { k: number[] }).k).toEqual([1, 2, 3]);
  });
});

describe("Python 沙箱 — 健康自检契约", () => {
  test("缺依赖时 fail-fast 返回 python_deps_missing + hint", async () => {
    /*
     * 这条用例只断言"健康不 ok 时的输出形态"：
     *   - error 是 python_deps_missing / python_unavailable / probe_timeout 之一
     *   - trace 里包含可操作的修复指引（bootstrap / QUBIT_PYTHON）
     * 健康环境下直接 skip。
     */
    if (pythonHealthy) return;
    const r = await runPythonSandbox({
      code: "result = 1",
      returnVar: "result",
    });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/python_deps_missing|python_unavailable|probe_timeout/);
    expect(r.trace ?? "").toMatch(/bootstrap|QUBIT_PYTHON|venv|pip/);
  });
});

describe("Python 沙箱 — 错误处理", () => {
  test("return_var 不存在 → ok=false + 清晰错误", async () => {
    if (skipIfUnhealthy()) return;
    const r = await runPythonSandbox({
      code: "x = 1",
      returnVar: "result",
    });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/result|not defined/i);
  });

  test("空 code 抛错", async () => {
    const r = await runPythonSandbox({ code: "" }).catch((e) => ({
      ok: false,
      error: (e as Error).message,
    }));
    // python_unavailable / python_deps_missing 也可以接受（环境不满足）
    const err = (r as { error?: string }).error ?? "";
    if (skipIfUnhealthy() && /python_unavailable|python_deps_missing/.test(err)) return;
    expect(r.ok).toBe(false);
  });
});
