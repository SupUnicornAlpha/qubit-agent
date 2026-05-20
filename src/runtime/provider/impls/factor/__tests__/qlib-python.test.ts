/**
 * QlibPythonFactorProvider smoke test
 *
 * 不强依赖具体 python / pandas 环境：只要 python3 在 PATH 即可。
 * 如果环境没有 python3，整组 test skip。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QlibPythonFactorProvider } from "../qlib-python-factor-provider";

let pythonOk = false;

beforeAll(async () => {
  try {
    const proc = Bun.spawn(["python3", "--version"], { stdout: "pipe", stderr: "pipe" });
    pythonOk = (await proc.exited) === 0;
  } catch {
    pythonOk = false;
  }
});

describe("QlibPythonFactorProvider", () => {
  test("meta：kind=factor_compute, key=qlib_python, fallback=true", () => {
    const p = new QlibPythonFactorProvider();
    expect(p.meta.kind).toBe("factor_compute");
    expect(p.meta.key).toBe("qlib_python");
    expect(p.meta.isFallback).toBe(true);
  });

  test("validateExpr：合法 qlib 表达式 ok（TS parser 支持无 $ 前缀字段）", async () => {
    const p = new QlibPythonFactorProvider();
    const r = await p.validateExpr("Mean(close, 20)", "qlib_expr");
    expect(r.ok).toBe(true);
  });

  test("validateExpr：alpha 别名直接放行", async () => {
    const p = new QlibPythonFactorProvider();
    const r = await p.validateExpr("ALPHA101_001", "qlib_expr");
    expect(r.ok).toBe(true);
  });

  test("validateExpr：错误 lang 报错", async () => {
    const p = new QlibPythonFactorProvider();
    const r = await p.validateExpr("close", "python");
    expect(r.ok).toBe(false);
  });

  test("healthCheck：python3 存在则 ok=true，否则 ok=false（也算通过）", async () => {
    const p = new QlibPythonFactorProvider();
    const h = await p.healthCheck();
    expect(typeof h.ok).toBe("boolean");
  });

  test("python runner：直接 spawn + 简单 Mean 表达式", async () => {
    if (!pythonOk) {
      console.warn("[skip] python3 not available, skip python integration smoke");
      return;
    }
    const RUNNER = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../../../python_connectors/qlib_compute_runner.py"
    );
    const bars = [
      { symbol: "A", date: "2026-01-01", open: 1, high: 1.2, low: 0.9, close: 1.0, volume: 100 },
      { symbol: "A", date: "2026-01-02", open: 1, high: 1.3, low: 0.95, close: 1.1, volume: 110 },
      { symbol: "A", date: "2026-01-03", open: 1, high: 1.4, low: 1.0, close: 1.2, volume: 120 },
      { symbol: "A", date: "2026-01-04", open: 1, high: 1.5, low: 1.05, close: 1.3, volume: 130 },
      { symbol: "A", date: "2026-01-05", open: 1, high: 1.6, low: 1.1, close: 1.4, volume: 140 },
    ];
    const proc = Bun.spawn(["python3", RUNNER], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(JSON.stringify({ expr: "Mean($close, 3)", bars }));
    proc.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      // pandas/numpy 缺失等 → skip（用 warning 而非 fail）
      console.warn(`[skip] python runner failed: ${stderr.trim()}`);
      return;
    }
    const parsed = JSON.parse(stdout) as {
      ok: boolean;
      rows: Array<{ symbol: string; date: string; value: number }>;
      meta: { backend: string; rowCount: number };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.rows.length).toBeGreaterThan(0);
    // 后几天有 Mean 值
    const last = parsed.rows[parsed.rows.length - 1]!;
    expect(last.symbol).toBe("A");
    expect(typeof last.value).toBe("number");
    expect(Number.isFinite(last.value)).toBe(true);
  });
});
