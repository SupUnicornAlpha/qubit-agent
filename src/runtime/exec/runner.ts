/**
 * Exec Runner — 子进程执行核心
 *
 * 安全四道闸：
 *   1. provider 必须在注册表里（registry 层做）
 *   2. cwd 必须落在 workdirStrategy 限定的根目录下（防 `..` 逃逸）
 *   3. argv 走数组形式不经 shell（Bun.spawn 默认；额外做元字符防御）
 *   4. wall-clock 超时 + 输出截断（参考 python-sandbox 的 +5s 缓冲范式）
 *
 * 错误统一返回 `ExecResult{ok:false, error: <code>, errorDetail: <人类可读>}`，
 * 上层 builtin-tools handler 直接 return（不 throw），让 act 节点把结构化错误回传 LLM
 * 用于自纠错——这一点与 python-sandbox 的范式一致。
 */

import { isAbsolute, normalize, resolve, sep } from "node:path";
import type { Subprocess } from "bun";
import { getDataDir } from "../agent/agent-pack-service";
import type { ExecProvider, ExecResult } from "./types";

/**
 * Wall-clock 缓冲：进程被 SIGTERM 后自清理留出的时间。
 * 1s 对绝大多数 binary 足够；python-sandbox 用 5s 是因为 SIGALRM 退出更慢。
 */
const WALL_CLOCK_BUFFER_MS = 1_000;
/** 最小允许 timeout（毫秒）；防 LLM 误传 1ms */
const MIN_TIMEOUT_MS = 100;

/** shell 元字符防御白名单（即使 Bun.spawn 走数组不经 shell，也做二次拦截，避免 binary 自身展开） */
const SHELL_METACHAR_REGEX = /[;&|`$<>\n\r]/;

/** 校验 cwd 是否在 provider 允许的根目录下 */
export function checkCwdScope(
  cwd: string,
  provider: ExecProvider,
  ctx: { projectId?: string; workflowId?: string }
): { ok: boolean; allowedRoot?: string; reason?: string } {
  if (!isAbsolute(cwd)) {
    return { ok: false, reason: `cwd must be absolute path (got: ${cwd})` };
  }
  const normalized = normalize(cwd);
  if (normalized.includes(`..${sep}`) || normalized.endsWith(`${sep}..`) || normalized === "..") {
    return { ok: false, reason: `cwd must not contain '..' (got: ${cwd})` };
  }
  const dataDir = getDataDir();
  let allowedRoot: string;
  switch (provider.workdirStrategy) {
    case "workflow-scoped": {
      if (!ctx.projectId || !ctx.workflowId) {
        return {
          ok: false,
          reason: `provider "${provider.id}" requires workflow-scoped cwd but projectId/workflowId missing in context`,
        };
      }
      allowedRoot = resolve(dataDir, "projects", ctx.projectId, "workflows", ctx.workflowId);
      break;
    }
    case "project-scoped": {
      if (!ctx.projectId) {
        return {
          ok: false,
          reason: `provider "${provider.id}" requires project-scoped cwd but projectId missing in context`,
        };
      }
      allowedRoot = resolve(dataDir, "projects", ctx.projectId);
      break;
    }
    case "data-dir-scoped":
      allowedRoot = resolve(dataDir);
      break;
  }
  const resolvedCwd = resolve(normalized);
  if (resolvedCwd !== allowedRoot && !resolvedCwd.startsWith(`${allowedRoot}${sep}`)) {
    return {
      ok: false,
      allowedRoot,
      reason: `cwd "${resolvedCwd}" escapes allowed root "${allowedRoot}"`,
    };
  }
  return { ok: true, allowedRoot };
}

/**
 * 校验 args：
 *   - 不允许 shell 元字符（即使 spawn 不经 shell，部分 binary 内部会再调 shell，做二次防御）
 *   - allowFreeformArgs=false 时，args[0] 必须在 allowedSubcommands 中
 */
export function checkArgs(
  provider: ExecProvider,
  args: string[]
): { ok: boolean; reason?: string } {
  for (const a of args) {
    if (typeof a !== "string") {
      return { ok: false, reason: `all args must be strings (got: ${typeof a})` };
    }
    if (SHELL_METACHAR_REGEX.test(a)) {
      return {
        ok: false,
        reason: `args contain shell metachar (one of ;&|\`$<>\\n); got: ${JSON.stringify(a)}`,
      };
    }
  }
  if (provider.allowFreeformArgs === false) {
    const sub = args[0] ?? "";
    const allowed = provider.allowedSubcommands ?? [];
    if (!allowed.includes(sub)) {
      return {
        ok: false,
        reason: `subcommand "${sub}" not in allowedSubcommands [${allowed.join(", ")}]`,
      };
    }
  }
  return { ok: true };
}

/** 按 envAllowlist 过滤当前进程的 env，避免 leak 不相关的 secret */
export function filterEnv(provider: ExecProvider): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of provider.envAllowlist) {
    const v = process.env[name];
    if (typeof v === "string") out[name] = v;
  }
  return out;
}

/** 把 cli_agent 的 argTemplate 占位符替换成实际值 */
export function renderArgTemplate(
  template: ReadonlyArray<string>,
  vars: { prompt: string; cwd: string; files?: string[] }
): string[] {
  const out: string[] = [];
  for (const t of template) {
    if (t === "{prompt}") {
      out.push(vars.prompt);
    } else if (t === "{cwd}") {
      out.push(vars.cwd);
    } else if (t === "{files...}") {
      if (vars.files && vars.files.length > 0) {
        out.push(...vars.files);
      }
    } else {
      out.push(t);
    }
  }
  return out;
}

export interface RunExecInput {
  provider: ExecProvider;
  args: string[];
  cwd: string;
  stdinText?: string;
  timeoutMs?: number;
  /** 由 builtin handler 注入：用于错误日志归因，不参与执行 */
  toolCallContext?: {
    workflowId?: string;
    projectId?: string;
    agentInstanceId?: string;
  };
}

/**
 * 执行 exec 调用（已假定 cwd / args 已通过校验；调用方应先调 checkCwdScope + checkArgs）。
 *
 * 不在这里做注册表查找——那是 builtin handler 的职责，让 runner 保持纯执行语义、好测试。
 */
export async function runExec(input: RunExecInput): Promise<ExecResult> {
  const { provider, args, cwd, stdinText } = input;
  const startedAt = Date.now();
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? provider.defaultTimeoutMs, MIN_TIMEOUT_MS),
    provider.defaultTimeoutMs
  );

  let proc: Subprocess;
  try {
    proc = Bun.spawn([provider.command, ...args], {
      cwd,
      env: filterEnv(provider),
      stdin: stdinText !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const notFound = /ENOENT|not found|No such file/i.test(msg);
    return {
      ok: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      elapsedMs: Date.now() - startedAt,
      error: notFound ? "binary_not_found" : "exec_failed",
      errorDetail: `spawn failed: ${msg}`,
    };
  }

  if (stdinText !== undefined && proc.stdin) {
    const stdin = proc.stdin as { write: (data: string) => void; end: () => void };
    try {
      stdin.write(stdinText);
      stdin.end();
    } catch {
      // 子进程可能在我们写完之前已退出，忽略 EPIPE
    }
  }

  const wallTimeoutMs = timeoutMs + WALL_CLOCK_BUFFER_MS;
  const wall = new Promise<"timeout">((res) => {
    setTimeout(() => res("timeout"), wallTimeoutMs);
  });

  const work = Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
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
      exitCode: null,
      stdout: "",
      stderr: "",
      truncated: false,
      elapsedMs: Date.now() - startedAt,
      error: "wall_timeout",
      errorDetail: `process killed after ${wallTimeoutMs}ms (timeoutMs=${timeoutMs} + ${WALL_CLOCK_BUFFER_MS}ms buffer)`,
    };
  }

  const [stdoutRaw, stderrRaw, exitCode] = winner;
  const totalBytes = Buffer.byteLength(stdoutRaw, "utf-8") + Buffer.byteLength(stderrRaw, "utf-8");
  const truncated = totalBytes > provider.maxOutputBytes;
  const limit = provider.maxOutputBytes;
  const stdout = truncated ? truncateUtf8(stdoutRaw, Math.floor(limit * 0.7)) : stdoutRaw;
  const stderr = truncated ? truncateUtf8(stderrRaw, Math.floor(limit * 0.3)) : stderrRaw;

  const elapsedMs = Date.now() - startedAt;
  return {
    ok: exitCode === 0 && !truncated,
    exitCode,
    stdout,
    stderr,
    truncated,
    elapsedMs,
    ...(truncated
      ? { error: "output_truncated", errorDetail: `output exceeded ${limit} bytes` }
      : {}),
    ...(exitCode !== 0 && !truncated
      ? { error: "nonzero_exit", errorDetail: `exit code ${exitCode}` }
      : {}),
  };
}

/** 按 utf-8 字节截断字符串（不破坏多字节字符） */
function truncateUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= maxBytes) return s;
  // 退一位避免砍断 utf-8 多字节序列
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return `${buf.subarray(0, end).toString("utf-8")}\n…[truncated]`;
}
