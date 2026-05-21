/**
 * Python 沙箱执行 — TS 端胶水
 *
 * 协议：spawn `python3 python_connectors/code_sandbox_runner.py`，
 * stdin 写 JSON，stdout 读 JSON，与 qlib_compute_runner 同风格。
 *
 * 调用方：runtime/tools/builtin-tools.ts 的 `code.run_python` handler，
 * Agent 在 chat 流程里调用，主要用途：
 *   - 拿到大量行情/因子值后跑 pandas 计算 IC 矩阵 / 相关性矩阵
 *   - 自定义多因子聚合
 *   - 临时回归分析
 *
 * 安全约束在 Python 侧（受限 builtins + import 白名单 + audit hook + SIGALRM 超时）；
 * 这里 TS 侧仅做参数封装 + 超时 wall-clock 兜底 + spawn 失败优雅降级。
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../python_connectors/code_sandbox_runner.py"
);

export interface PythonSandboxRequest {
  /** 待执行的 Python 代码 */
  code: string;
  /** 注入到 ns 的变量；顶级 key 同时展开为顶级变量（如 vars.bars 也可直接用 bars） */
  vars?: Record<string, unknown>;
  /** 超时秒（默认 30，硬上限 120） */
  timeoutSec?: number;
  /** stdout 最大字节数（默认 64KB，硬上限 512KB） */
  maxStdoutBytes?: number;
  /** 若提供：把这个变量序列化为 JSON 返回（DataFrame/Series/ndarray 会被适配） */
  returnVar?: string;
}

export interface PythonSandboxResponse {
  ok: boolean;
  stdout: string;
  result: unknown;
  /** 总耗时（毫秒），Python 侧测量 */
  elapsedMs: number;
  rowsInResult: number;
  /** 失败原因（如 timeout / permission_denied / import_error / runtime_error / python_unavailable） */
  error?: string;
  trace?: string;
}

interface RawPyResponse {
  ok: boolean;
  stdout?: string;
  result?: unknown;
  elapsed_ms?: number;
  rows_in_result?: number;
  error?: string;
  detail?: string;
  trace?: string;
}

/** Wall-clock 超时（额外宽限 5s 给 Python 端 SIGALRM 自清理） */
const WALL_CLOCK_BUFFER_MS = 5_000;

export async function runPythonSandbox(
  req: PythonSandboxRequest
): Promise<PythonSandboxResponse> {
  const payload = {
    code: req.code,
    vars: req.vars ?? {},
    timeout_sec: req.timeoutSec ?? 30,
    max_stdout_bytes: req.maxStdoutBytes ?? 65_536,
    ...(req.returnVar ? { return_var: req.returnVar } : {}),
  };

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["python3", RUNNER_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      result: null,
      elapsedMs: 0,
      rowsInResult: 0,
      error: "python_unavailable",
      trace: (e as Error).message,
    };
  }

  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();

  const wallTimeoutMs = (payload.timeout_sec + 1) * 1000 + WALL_CLOCK_BUFFER_MS;
  const wall = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), wallTimeoutMs);
  });

  const work = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const winner = await Promise.race([work, wall]);

  if (winner === "timeout") {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    return {
      ok: false,
      stdout: "",
      result: null,
      elapsedMs: wallTimeoutMs,
      rowsInResult: 0,
      error: "wall_timeout",
    };
  }

  const [stdout, stderr, exitCode] = winner;

  // 解析 Python 端 JSON 输出（即使 exit != 0 也可能有结构化错误）
  let parsed: RawPyResponse | null = null;
  if (stdout.trim().length > 0) {
    try {
      parsed = JSON.parse(stdout.trim()) as RawPyResponse;
    } catch {
      // ignore，落到原始错误
    }
  }

  if (parsed) {
    const resp: PythonSandboxResponse = {
      ok: parsed.ok === true,
      stdout: parsed.stdout ?? "",
      result: parsed.result ?? null,
      elapsedMs: parsed.elapsed_ms ?? 0,
      rowsInResult: parsed.rows_in_result ?? 0,
    };
    if (!parsed.ok) {
      resp.error = parsed.error ?? "sandbox_error";
      if (parsed.trace) resp.trace = parsed.trace;
      if (parsed.detail) resp.trace = parsed.detail;
    }
    return resp;
  }

  return {
    ok: false,
    stdout: "",
    result: null,
    elapsedMs: 0,
    rowsInResult: 0,
    error: `python_exit_${exitCode}`,
    trace: stderr.trim().slice(0, 1500) || stdout.trim().slice(0, 1500),
  };
}
