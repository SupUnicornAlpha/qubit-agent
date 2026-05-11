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

type Pooled = {
  proc: Subprocess;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  lines: AsyncGenerator<string, void, unknown>;
  initialized: boolean;
  nextRpcId: number;
};

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

async function writeLine(writer: WritableStreamDefaultWriter<Uint8Array>, obj: Record<string, unknown>) {
  const line = `${JSON.stringify(obj)}\n`;
  await writer.write(new TextEncoder().encode(line));
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

  const proc = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
    cwd,
  });

  if (!proc.stdin || !proc.stdout) throw new Error("stdio MCP: subprocess missing pipes");

  const writer = proc.stdin.getWriter();
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
      await writeLine(pool.writer, {
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

      await writeLine(pool.writer, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      });
      pool.initialized = true;
    }

    const callId = pool.nextRpcId++;
    await writeLine(pool.writer, {
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
