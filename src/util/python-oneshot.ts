/**
 * Python 一次性子进程调用工具：spawn → stdin 写 JSON → 等待 → stdout 解析 JSON。
 *
 * P2-G 收敛：仓库里 5 处独立实现的同一模式：
 *   - market/python-signal-runner.ts
 *   - market/python-strategy-backtest-runner.ts
 *   - strategy/signal-evaluator.ts (2 处)
 *   - provider/impls/factor/qlib-python-factor-provider.ts
 *
 * 每处都重复写"spawn / stdin.write(JSON.stringify(...)) / stdin.end() /
 * Promise.all([stdout.text(), stderr.text(), proc.exited]) / JSON.parse"
 * 这套样板，并且各自实现的 timeout / error 分类策略不一致。
 *
 * 本 util 的核心约定：
 *   - **抛错**而不是返回 `{ok:false}`：caller 自己决定怎么转 result shape
 *     （signal-evaluator 返回 `{ buy:false, sell:false, error }`、
 *     python-signal-runner 直接 throw、其它各异 —— 不强求统一）
 *   - 错误分四类（source 字段）：`spawn / timeout / exit / parse`，便于 caller
 *     用 errorClass 决定是否重试 / 退化
 *
 * 不接管：
 *   - stdio-session.ts / mcp 长连接子进程（双向消息，不是 oneshot）
 *   - python-bridge.ts 的 JSON-RPC 长连接（P0-4 已有 PYTHON_CALL_TIMEOUT_MS 兜底）
 *   - sandbox/python-runtime.ts / python-sandbox.ts（沙箱专属编排）
 *   - mcp/package-manager.ts / bootstrap/packaged-setup.ts（pip install 等 setup）
 */

export const PYTHON_ONESHOT_DEFAULT_TIMEOUT_MS = 60_000;

/**
 * 用统一 stdio 模式（stdin/stdout/stderr 都 pipe）spawn 子进程。
 *
 * 抽出来是为了：
 *   1. 调用处不再写 `Bun.spawn(...)` 那套样板
 *   2. TS 类型固定（stdin 类型固定为 FileSink、stdout/stderr 为 ReadableStream）
 */
function spawnForOneShot(cmd: string[], extraEnv?: Record<string, string>) {
  return Bun.spawn(cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(extraEnv ?? {}) } as Record<string, string>,
  });
}

export type PythonOneShotErrorSource = "spawn" | "timeout" | "exit" | "parse";

export class PythonOneShotError extends Error {
  readonly source: PythonOneShotErrorSource;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    source: PythonOneShotErrorSource,
    message: string,
    opts?: { exitCode?: number | null; stdout?: string; stderr?: string },
  ) {
    super(message);
    this.name = "PythonOneShotError";
    this.source = source;
    this.exitCode = opts?.exitCode ?? null;
    this.stdout = opts?.stdout ?? "";
    this.stderr = opts?.stderr ?? "";
  }
}

export interface RunPythonOneShotInput {
  /** Python 二进制路径（通常来自 getPythonBin()） */
  bin: string;
  /** Python 脚本绝对路径 */
  scriptPath: string;
  /** 拼在 `bin + scriptPath` 后的额外命令行参数（默认 []） */
  args?: string[];
  /** stdin 写入的 payload（会 JSON.stringify）；为空则不写 stdin */
  stdinPayload?: unknown;
  /** 进程整体超时（毫秒）。默认 60s。命中后 kill + 抛 PythonOneShotError(source='timeout') */
  timeoutMs?: number;
  /** 自定义 env（合并到 process.env） */
  env?: Record<string, string>;
}

export interface PythonOneShotResult<R = unknown> {
  /** stdout JSON.parse 后的结果 */
  parsed: R;
  /** 原始 stdout 字符串（debug 用） */
  stdout: string;
  /** 原始 stderr 字符串（debug 用） */
  stderr: string;
  /** 进程 exit code */
  exitCode: number;
}

/**
 * 跑一次 Python oneshot，stdout JSON.parse 后返回。
 *
 * 行为：
 *   - 任何 spawn / timeout / exit !=0 / JSON.parse 失败都抛 PythonOneShotError
 *   - exit==0 且 stdout 为空也算 parse 失败
 *   - exit !=0 但 stdout 是合法 JSON 时**仍抛 exit 错误**（保持"exit code 优先"语义；
 *     如果 caller 明确想要"exit !=0 但 stdout 是 ok JSON"的语义，自己 try/catch）
 */
export async function runPythonOneShot<R = unknown>(
  input: RunPythonOneShotInput,
): Promise<PythonOneShotResult<R>> {
  const timeoutMs = input.timeoutMs ?? PYTHON_ONESHOT_DEFAULT_TIMEOUT_MS;
  const cmd = [input.bin, input.scriptPath, ...(input.args ?? [])];

  let proc: ReturnType<typeof spawnForOneShot>;
  try {
    proc = spawnForOneShot(cmd, input.env);
  } catch (err) {
    throw new PythonOneShotError(
      "spawn",
      `failed to spawn python: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    if (input.stdinPayload !== undefined) {
      proc.stdin.write(JSON.stringify(input.stdinPayload));
    }
    proc.stdin.end();
  } catch (err) {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    throw new PythonOneShotError(
      "spawn",
      `failed to write stdin: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /**
   * timeout 用 setTimeout + proc.kill()，让 proc.exited resolve（非零 exit），
   * Promise.all 收集到 stdout/stderr 后我们手动抛 timeout 错误。
   */
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw new PythonOneShotError("timeout", `python oneshot timed out after ${timeoutMs}ms`, {
      exitCode,
      stdout,
      stderr,
    });
  }

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim().slice(0, 400) || "(no output)";
    throw new PythonOneShotError("exit", `python exited ${exitCode}: ${detail}`, {
      exitCode,
      stdout,
      stderr,
    });
  }

  try {
    const parsed = JSON.parse(stdout) as R;
    return { parsed, stdout, stderr, exitCode };
  } catch (err) {
    const detail = stderr.trim() || stdout.slice(0, 400);
    throw new PythonOneShotError(
      "parse",
      `python stdout is not JSON: ${err instanceof Error ? err.message : String(err)} | head=${detail}`,
      { exitCode, stdout, stderr },
    );
  }
}

/**
 * 只跑命令、不解析 JSON（如 `python --version` 健康检查）。
 *
 * 错误：spawn / timeout / exit !=0 抛 PythonOneShotError；exit==0 直接返回 stdout/stderr。
 */
export async function runPythonOneShotRaw(
  input: Omit<RunPythonOneShotInput, "stdinPayload"> & { stdinPayload?: unknown },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const timeoutMs = input.timeoutMs ?? PYTHON_ONESHOT_DEFAULT_TIMEOUT_MS;
  const cmd = [input.bin, input.scriptPath, ...(input.args ?? [])];

  let proc: ReturnType<typeof spawnForOneShot>;
  try {
    proc = spawnForOneShot(cmd, input.env);
  } catch (err) {
    throw new PythonOneShotError(
      "spawn",
      `failed to spawn python: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (input.stdinPayload !== undefined) {
    proc.stdin.write(JSON.stringify(input.stdinPayload));
  }
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  let exitCode = -1;
  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (timedOut) {
    throw new PythonOneShotError("timeout", `python oneshot timed out after ${timeoutMs}ms`, {
      exitCode,
      stdout,
      stderr,
    });
  }

  if (exitCode !== 0) {
    throw new PythonOneShotError("exit", `python exited ${exitCode}`, {
      exitCode,
      stdout,
      stderr,
    });
  }

  return { stdout, stderr, exitCode };
}
