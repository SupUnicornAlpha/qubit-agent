import type { Subprocess } from "bun";
import { collectRpcResponse } from "./jsonrpc-ndjson";

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

export function stdioArgvFromServer(command: string | null | undefined, capabilitiesJson: unknown): string[] {
  const caps =
    capabilitiesJson && typeof capabilitiesJson === "object" && !Array.isArray(capabilitiesJson)
      ? (capabilitiesJson as Record<string, unknown>)
      : {};
  return parseArgv(command, caps);
}

type StdinLineWriter = {
  writeLine: (obj: Record<string, unknown>) => Promise<void>;
};

type Pooled = {
  proc: Subprocess;
  writer: StdinLineWriter;
  lines: AsyncGenerator<string, void, unknown>;
  initialized: boolean;
  nextRpcId: number;
};

function createStdinLineWriter(stdin: NonNullable<Subprocess["stdin"]>): StdinLineWriter {
  const stream = stdin as WritableStream<Uint8Array>;
  if (typeof stream.getWriter === "function") {
    const w = stream.getWriter();
    return {
      writeLine: async (obj) => {
        await w.write(new TextEncoder().encode(`${JSON.stringify(obj)}\n`));
      },
    };
  }
  return {
    writeLine: async (obj) => {
      stdin.write(`${JSON.stringify(obj)}\n`);
    },
  };
}

const pools = new Map<string, Pooled>();
const serialTail = new Map<string, Promise<unknown>>();

function runSerialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = serialTail.get(key) ?? Promise.resolve();
  const p = prev.then(fn);
  serialTail.set(key, p.then(() => undefined).catch(() => undefined));
  return p as Promise<T>;
}

async function* readNdjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
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

async function ensurePool(key: string, argv: string[], env: Record<string, string>, cwd?: string): Promise<Pooled> {
  const existing = pools.get(key);
  if (existing) return existing;

  if (existing?.proc.kill) {
    try {
      existing.proc.kill();
    } catch {
      // ignore
    }
    pools.delete(key);
  }

  let proc: Subprocess;
  try {
    proc = Bun.spawn(argv, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
      cwd,
    });
  } catch (e) {
    const hint =
      argv[0] === "uvx" || argv.join(" ").includes("uvx")
        ? " 这些内置 MCP 的 command 依赖 uvx。请安装 uv（https://docs.astral.sh/uv/getting-started/installation/），并确保启动本服务时的 PATH 包含 uvx（例如在终端里 `which uvx` 能成功后再启动后端），或在配置里把 command 改成 uvx 的绝对路径。"
        : " 请检查 command 第一个可执行文件是否已安装，并在当前进程的 PATH 中可用，或改为绝对路径。";
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(`MCP stdio 无法启动子进程（${argv[0] ?? "?"}）：${raw}。${hint}`);
  }

  if (!proc.stdin || !proc.stdout) throw new Error("stdio MCP: subprocess missing pipes");

  const writer = createStdinLineWriter(proc.stdin);
  const lines = readNdjsonLines(proc.stdout);

  void (async () => {
    const errReader = proc.stderr?.getReader();
    if (!errReader) return;
    const dec = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await errReader.read();
        if (done) break;
        const t = dec.decode(value);
        if (t.trim()) console.error(`[mcp stderr ${key}]`, t.trimEnd());
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
  };
  pools.set(key, pooled);
  void proc.exited.then(() => {
    const cur = pools.get(key);
    if (cur?.proc === proc) pools.delete(key);
  });
  return pooled;
}

export async function callMcpStdioTool(
  opts: McpStdioSessionOptions & {
    toolName: string;
    arguments: Record<string, unknown>;
  }
): Promise<unknown> {
  const timeout = opts.requestTimeoutMs ?? 60_000;
  const argv = opts.argv;
  if (argv.length === 0) throw new Error("MCP stdio: empty argv (set mcp_server_config.command or capabilitiesJson.argv)");

  return runSerialized(opts.serverKey, async () => {
    const pool = await ensurePool(opts.serverKey, argv, opts.env ?? {}, opts.cwd);

    if (!pool.initialized) {
      const initId = pool.nextRpcId++;
      await pool.writer.writeLine({
        jsonrpc: "2.0",
        id: initId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "qubit-agent", version: "0.1.0" },
        },
      });
      const rInit = await collectRpcResponse(pool.lines, initId, timeout);
      if (rInit.error) throw new Error(`MCP initialize failed: ${rInit.error.message}`);

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
    const rCall = await collectRpcResponse(pool.lines, callId, timeout);
    if (rCall.error) throw new Error(rCall.error.message);
    return rCall.result;
  });
}

export function killMcpStdioPool(serverKey: string) {
  const p = pools.get(serverKey);
  if (!p) return;
  try {
    p.proc.kill?.();
  } catch {
    // ignore
  }
  pools.delete(serverKey);
}
