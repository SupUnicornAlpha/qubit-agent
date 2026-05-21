/**
 * Python 沙箱 — 行为契约测试
 *
 * 依赖 python3 在 PATH（CI 环境通常有）；若不存在则 skip 关键 case。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { runPythonSandbox } from "../python-sandbox";

let pythonOk = false;

beforeAll(async () => {
  try {
    const proc = Bun.spawn(["python3", "--version"], { stdout: "pipe", stderr: "pipe" });
    pythonOk = (await proc.exited) === 0;
  } catch {
    pythonOk = false;
  }
});

function skipIfNoPython(): boolean {
  if (!pythonOk) {
    console.warn("[skip] python3 not available");
    return true;
  }
  return false;
}

describe("Python 沙箱 — 基础执行", () => {
  test("简单求和 + return_var", async () => {
    if (skipIfNoPython()) return;
    const r = await runPythonSandbox({
      code: "result = sum(vars['nums'])",
      vars: { nums: [1, 2, 3, 4, 5] },
      returnVar: "result",
    });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(15);
  });

  test("print → stdout 被捕获", async () => {
    if (skipIfNoPython()) return;
    const r = await runPythonSandbox({
      code: "print('hello'); print(42)",
    });
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("hello");
    expect(r.stdout).toContain("42");
  });

  test("vars 顶级展开：可直接用 bars 而非 vars['bars']", async () => {
    if (skipIfNoPython()) return;
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
    if (skipIfNoPython()) return;
    const r = await runPythonSandbox({ code: "import os" });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/not allowed|os/i);
  });

  test("禁止 import subprocess", async () => {
    if (skipIfNoPython()) return;
    const r = await runPythonSandbox({ code: "import subprocess" });
    expect(r.ok).toBe(false);
  });

  test("禁止 import socket", async () => {
    if (skipIfNoPython()) return;
    const r = await runPythonSandbox({ code: "import socket" });
    expect(r.ok).toBe(false);
  });

  test("禁止 open()（不在受限 builtins 里）", async () => {
    if (skipIfNoPython()) return;
    const r = await runPythonSandbox({ code: "open('/etc/passwd')" });
    expect(r.ok).toBe(false);
    expect(r.error ?? "").toMatch(/open|not defined/i);
  });

  test("禁止 eval / exec（不在受限 builtins 里）", async () => {
    if (skipIfNoPython()) return;
    const r = await runPythonSandbox({ code: "eval('1+1')" });
    expect(r.ok).toBe(false);
  });

  test("放行 import math / numpy（如装了）", async () => {
    if (skipIfNoPython()) return;
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
    if (skipIfNoPython()) return;
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
    if (skipIfNoPython()) return;
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
    if (skipIfNoPython()) return;
    const r = await runPythonSandbox({
      code: "result = {'k': [1, 2, 3], 'm': 'x'}",
      returnVar: "result",
    });
    expect(r.ok).toBe(true);
    expect((r.result as { k: number[] }).k).toEqual([1, 2, 3]);
  });
});

describe("Python 沙箱 — 错误处理", () => {
  test("return_var 不存在 → ok=false + 清晰错误", async () => {
    if (skipIfNoPython()) return;
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
    // python_unavailable 也可以接受（环境无 python3）
    if (skipIfNoPython() && (r as { error?: string }).error === "python_unavailable") return;
    expect(r.ok).toBe(false);
  });
});
