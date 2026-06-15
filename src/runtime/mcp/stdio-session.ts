import { spawn as nodeSpawn } from "node:child_process";
import { Readable } from "node:stream";
import { McpStreamClosedError, collectRpcResponse } from "./jsonrpc-ndjson";
import {
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpProtocolVersion,
  isSupportedMcpProtocolVersion,
  isUnsupportedProtocolVersionError,
} from "./mcp-protocol";

export type McpStdioSessionOptions = {
  serverKey: string;
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
};

function parseArgv(command: string | null | undefined, caps: Record<string, unknown>): string[] {
  const fromCaps = caps.argv;
  if (Array.isArray(fromCaps) && fromCaps.every((x) => typeof x === "string")) {
    return fromCaps as string[];
  }
  const raw = command?.trim();
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as unknown;
    if (Array.isArray(j) && j.every((x) => typeof x === "string")) return j as string[];
  } catch {
    // fall through
  }
  return raw.split(/\s+/).filter(Boolean);
}

export function stdioArgvFromServer(
  command: string | null | undefined,
  capabilitiesJson: unknown
): string[] {
  const caps =
    capabilitiesJson && typeof capabilitiesJson === "object" && !Array.isArray(capabilitiesJson)
      ? (capabilitiesJson as Record<string, unknown>)
      : {};
  return parseArgv(command, caps);
}

type StdinLineWriter = {
  writeLine: (obj: Record<string, unknown>) => Promise<void>;
};

/** node:child_process 封装；Bun.spawn 管道下部分 npm MCP（mcp-financex）会提前断 stdout。 */
type McpStdioChild = {
  stdin: NodeJS.WritableStream;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  kill: () => void;
};

type Pooled = {
  proc: McpStdioChild;
  writer: StdinLineWriter;
  lines: AsyncGenerator<string, void, unknown>;
  initialized: boolean;
  nextRpcId: number;
  /** Last ~20 stderr lines, used to enrich error messages on crashes. */
  stderrBuf: string[];
  protocolVersion?: McpProtocolVersion;
};

function createStdinLineWriter(stdin: NodeJS.WritableStream): StdinLineWriter {
  return {
    writeLine: async (obj) => {
      const line = `${JSON.stringify(obj)}\n`;
      if (!stdin.write(line)) {
        await new Promise<void>((resolve) => stdin.once("drain", resolve));
      }
    },
  };
}

function spawnMcpStdioChild(
  argv: string[],
  env: Record<string, string>,
  cwd?: string
): McpStdioChild {
  const proc = nodeSpawn(argv[0]!, argv.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
    cwd,
  });
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error("stdio MCP: subprocess missing pipes");
  }
  return {
    stdin: proc.stdin,
    stdout: Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(proc.stderr) as ReadableStream<Uint8Array>,
    exited: new Promise((resolve) => proc.on("exit", (code) => resolve(code ?? null))),
    kill: () => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    },
  };
}

const pools = new Map<string, Pooled>();
const serialTail = new Map<string, Promise<unknown>>();

function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = serialTail.get(key) ?? Promise.resolve();
  const p = prev.then(fn);
  serialTail.set(
    key,
    p.then(() => undefined).catch(() => undefined)
  );
  return p as Promise<T>;
}

async function* readNdjsonLines(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        const t = p.trim();
        if (t) yield t;
      }
    }
    const tail = buf.trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

const STDERR_RING_MAX = 20;

function isEnoentLikeError(errno: unknown, raw: string): boolean {
  if (errno === "ENOENT") return true;
  return /ENOENT|not found|No such file or directory|command not found/i.test(raw);
}

function spawnFailureHint(argv: string[], rawMessage: string, errno: unknown): string {
  const cmd = argv[0] ?? "?";
  const uvxRelated = cmd === "uvx" || argv.join(" ").includes("uvx");
  const npxRelated = cmd === "npx" || argv.join(" ").includes("npx");
  if (isEnoentLikeError(errno, rawMessage)) {
    const base = `命令 \`${cmd}\` 在当前 PATH 中找不到。请先安装并确保启动后端的环境里可执行（终端中 \`which ${cmd}\` 应能成功），或在配置里使用绝对路径。`;
    if (uvxRelated) {
      return `${base} 这是依赖 uvx 的 MCP，请安装 uv（https://docs.astral.sh/uv/getting-started/installation/）。`;
    }
    if (npxRelated) {
      return `${base} 这是依赖 npx 的 MCP，请安装 Node.js（含 npm/npx）。`;
    }
    return base;
  }
  if (uvxRelated) {
    return "依赖 uvx 的 MCP 启动失败，请安装 uv 并把 uvx 加入 PATH（https://docs.astral.sh/uv/getting-started/installation/）。";
  }
  return "请检查 command 第一个可执行文件是否已安装、是否在当前进程 PATH 中可用，或改为绝对路径。";
}

/**
 * F-P0-07 fix（2026-06-04）：错误消息的 stderr tail 按「行」截断，不按 byte。
 *
 * 之前 `stderrBuf.slice(-10).join("").trim().slice(-1200)` 是直接按字节切尾，
 * 正好可能从 `…/financials.js:175:28` 中间砍掉首字符变成 `inancials.js:175:28`，
 * 让排查者误以为路径被吃掉。这次改为：
 *   1) join 所有 chunk
 *   2) 按 `\n` split 取最后 20 行
 *   3) 每行最多 240 字符（保护单行 console.error 把整 JSON dump 全打进来）
 *
 * 导出供 stdio-session 单测调用；同时保留为 internal helper（前缀 `_` 即"测试钩子"）。
 */
export function _formatStdioExitErrorMessage(
  stderrChunks: readonly string[],
  code: number | null,
  phase: string
): string {
  const joined = stderrChunks.join("").trim();
  const header = `MCP stdio: 子进程在 ${phase} 阶段提前退出 (exit code=${code ?? "?"})`;
  if (!joined) return header;
  const MAX_LINES = 20;
  const MAX_LINE_LEN = 240;
  const tailLines = joined
    .split("\n")
    .slice(-MAX_LINES)
    .map((line) => (line.length > MAX_LINE_LEN ? `${line.slice(0, MAX_LINE_LEN)}…` : line));
  return `${header}\nstderr (tail):\n${tailLines.join("\n")}`;
}

/**
 * mcp-financex 常在写出 isError 帧后立刻 exit；若 stderr 里已有 tool error，优先返回业务错误。
 */
export function mcpToolErrorFromStderr(stderrChunks: readonly string[]): string | null {
  const joined = stderrChunks.join("");
  if (!joined.includes("[MCP] Tool error")) return null;
  const orig = joined.match(/originalMessage['"]?\s*:\s*['"]([^'"]+)['"]/);
  if (orig?.[1]) return orig[1];
  const code = joined.match(/code:\s*'([^']+)'/);
  if (code?.[1]) return `mcp-financex: ${code[1]}`;
  return "mcp-financex tool error (see server stderr)";
}

/** 子进程 exit 后仍可能有几帧 JSON-RPC 在 stdout 管道里；宽限期内继续等 rpc / stderr。 */
const RPC_EXIT_GRACE_MS = 2_500;

async function waitForStderrToolError(pool: Pooled, maxMs: number): Promise<string | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const err = mcpToolErrorFromStderr(pool.stderrBuf);
    if (err) return err;
    await new Promise((r) => setTimeout(r, 80));
  }
  return mcpToolErrorFromStderr(pool.stderrBuf);
}

async function exitErrorMessage(pool: Pooled, code: number | null, phase: string): Promise<string> {
  const toolErr = await waitForStderrToolError(pool, RPC_EXIT_GRACE_MS);
  return toolErr ?? _formatStdioExitErrorMessage(pool.stderrBuf, code, phase);
}

/**
 * Race a JSON-RPC response against subprocess exit. If the subprocess dies first
 * we surface a precise error (exit code + tail of stderr) instead of letting the
 * line stream silently close and producing a generic timeout.
 *
 * F-P0-07 fix（2026-06-04）：拿到 exit code 时**同步**把死 pool 从 `pools` map 删掉。
 * 之前依赖 `void proc.exited.then(() => pools.delete(key))` 异步清理；retry attempt 2
 * 进 `ensurePool` 时可能撞到尚未清理的僵尸 pool → 再次抛"子进程在 tools/call
 * 阶段提前退出"→ 内存熔断 + DB 熔断 翻 open → 同 batch 后续 9 个调用全 fail-fast。
 * eval batch 2 的 mcp-financex 9/9 失败就是这个 cascade。
 *
 * 2026-06-05：mcp-financex 在 tools/call 写出 isError 帧后仍可能很快 exit(1)；
 * 若 exit 先触发 race，给 stdout 再 2.5s 宽限读取响应，避免误报「提前退出」。
 */
async function raceRpcOrExit<T>(
  rpcPromise: Promise<T>,
  pool: Pooled,
  phase: string,
  serverKey: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    rpcPromise
      .then((v) => settle(() => resolve(v)))
      .catch((e) => {
        if (e instanceof McpStreamClosedError) {
          void (async () => {
            await new Promise((r) => setTimeout(r, RPC_EXIT_GRACE_MS));
            const code = await Promise.race<number | undefined>([
              pool.proc.exited,
              new Promise<undefined>((r) => setTimeout(() => r(undefined), 250)),
            ]).catch(() => undefined);
            const cur = pools.get(serverKey);
            if (cur?.proc === pool.proc) pools.delete(serverKey);
            const msg = await exitErrorMessage(pool, code ?? null, phase);
            settle(() => reject(new Error(msg)));
          })();
          return;
        }
        settle(() => reject(e));
      });

    void pool.proc.exited.then(async (code) => {
      await new Promise((r) => setTimeout(r, RPC_EXIT_GRACE_MS));
      const cur = pools.get(serverKey);
      if (cur?.proc === pool.proc) pools.delete(serverKey);
      const msg = await exitErrorMessage(pool, code ?? null, phase);
      settle(() => reject(new Error(msg)));
    });
  });
}

async function ensurePool(
  key: string,
  argv: string[],
  env: Record<string, string>,
  cwd?: string
): Promise<Pooled> {
  const existing = pools.get(key);
  if (existing) return existing;

  let proc: McpStdioChild;
  try {
    proc = spawnMcpStdioChild(argv, env, cwd);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException | undefined)?.code;
    const raw = e instanceof Error ? e.message : String(e);
    const hint = spawnFailureHint(argv, raw, errno);
    throw new Error(`MCP stdio 无法启动子进程（${argv[0] ?? "?"}）：${raw}。${hint}`);
  }

  const writer = createStdinLineWriter(proc.stdin);
  const lines = readNdjsonLines(proc.stdout);
  const stderrBuf: string[] = [];

  void (async () => {
    const errReader = proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await errReader.read();
        if (done) break;
        const t = dec.decode(value);
        if (t.trim()) {
          console.error(`[mcp stderr ${key}]`, t.trimEnd());
          stderrBuf.push(t);
          if (stderrBuf.length > STDERR_RING_MAX)
            stderrBuf.splice(0, stderrBuf.length - STDERR_RING_MAX);
        }
      }
    } finally {
      errReader.releaseLock();
    }
  })();

  const pooled: Pooled = {
    proc,
    writer,
    lines,
    initialized: false,
    nextRpcId: 1,
    stderrBuf,
  };
  pools.set(key, pooled);
  void proc.exited.then(() => {
    const cur = pools.get(key);
    if (cur?.proc === proc) pools.delete(key);
  });
  return pooled;
}

async function tryInitializeStdioAcrossVersions(
  pool: Pooled,
  timeout: number,
  serverKey: string
): Promise<McpProtocolVersion> {
  let lastError: unknown;
  for (const ver of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
    const initId = pool.nextRpcId++;
    try {
      await pool.writer.writeLine({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
          protocolVersion: ver,
          capabilities: {},
          clientInfo: { name: "qubit-agent", version: "0.1.0" },
        },
      });
      const rInit = await raceRpcOrExit(
        collectRpcResponse(pool.lines, initId, timeout),
        pool,
        "initialize",
        serverKey
      );
      if (rInit.error) {
        const msg = rInit.error.message ?? "";
        if (isUnsupportedProtocolVersionError(msg)) {
          lastError = new Error(msg);
          continue;
        }
        throw new Error(`MCP initialize failed: ${msg}`);
      }
      const serverVer = (rInit.result as { protocolVersion?: unknown } | undefined)
        ?.protocolVersion;
      return isSupportedMcpProtocolVersion(serverVer) ? serverVer : ver;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isUnsupportedProtocolVersionError(msg)) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  const last = lastError instanceof Error ? lastError.message : String(lastError ?? "");
  throw new Error(
    `MCP initialize failed: 子进程拒绝了我们支持的全部 protocolVersion (${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")})。最后一次错误: ${last}`
  );
}

/** MCP tools/call 成功帧里 isError=true 时，从 content 提取可读错误信息。 */
export function mcpToolResultErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as { isError?: boolean; content?: unknown };
  if (!r.isError) return null;
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block && typeof block === "object" && !Array.isArray(block)) {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.trim()) parts.push(text.trim());
      }
    }
  }
  if (parts.length === 0) return "MCP tool returned isError without content";
  const joined = parts.join("\n");
  try {
    const parsed = JSON.parse(joined) as { error?: string; code?: string };
    if (typeof parsed.error === "string") {
      return parsed.code ? `${parsed.code}: ${parsed.error}` : parsed.error;
    }
  } catch {
    // not JSON — use raw text
  }
  return joined.slice(0, 500);
}

export async function callMcpStdioTool(
  opts: McpStdioSessionOptions & {
    toolName: string;
    arguments: Record<string, unknown>;
  }
): Promise<unknown> {
  const timeout = opts.requestTimeoutMs ?? 60_000;
  const argv = opts.argv;
  if (argv.length === 0)
    throw new Error(
      "MCP stdio: empty argv (set mcp_server_config.command or capabilitiesJson.argv)"
    );

  return runSerialized(opts.serverKey, async () => {
    const pool = await ensurePool(opts.serverKey, argv, opts.env ?? {}, opts.cwd);

    if (!pool.initialized) {
      pool.protocolVersion = await tryInitializeStdioAcrossVersions(pool, timeout, opts.serverKey);
      await pool.writer.writeLine({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      });
      pool.initialized = true;
    }

    const callId = pool.nextRpcId++;
    await pool.writer.writeLine({
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: {
        name: opts.toolName,
        arguments: opts.arguments ?? {},
      },
    });
    const rCall = await raceRpcOrExit(
      collectRpcResponse(pool.lines, callId, timeout),
      pool,
      "tools/call",
      opts.serverKey
    );
    /**
     * 给 RPC error / isError 帧加 `[serverKey/toolName]` 前缀：多个 server 同时在跑时，
     * 光看 "At least 2 symbols required" 这类裸消息无法定位是哪个工具崩的。带上前缀后
     * 错误消息自包含定位信息，不必再 join DB 的 tool_name 列。raceRpcOrExit 抛的
     * 「子进程提前退出」已含 phase，不在此处重复加前缀。
     */
    if (rCall.error) throw new Error(prefixStdioToolError(opts.serverKey, opts.toolName, rCall.error.message));
    const toolErr = mcpToolResultErrorMessage(rCall.result);
    if (toolErr) throw new Error(prefixStdioToolError(opts.serverKey, opts.toolName, toolErr));
    return rCall.result;
  });
}

/**
 * 给 stdio 工具错误消息加 `[serverKey/toolName]` 前缀。纯函数，便于单测。
 * 已带前缀（重复调用 / 上游已标注）时不再叠加。
 */
export function prefixStdioToolError(
  serverKey: string,
  toolName: string,
  message: string
): string {
  const prefix = `[${serverKey}/${toolName}]`;
  return message.startsWith(prefix) ? message : `${prefix} ${message}`;
}

export function killMcpStdioPool(serverKey: string) {
  const p = pools.get(serverKey);
  if (!p) return;
  p.proc.kill();
  pools.delete(serverKey);
}
