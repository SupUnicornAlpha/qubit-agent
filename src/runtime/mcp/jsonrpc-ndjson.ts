export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export function parseJsonRpcLine(line: string): JsonRpcResponse | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as JsonRpcResponse;
  } catch {
    return null;
  }
}

/** Custom error thrown when the underlying line stream closes before any matching response arrived. */
export class McpStreamClosedError extends Error {
  readonly expectId: number | string;
  readonly sawAnyLine: boolean;
  constructor(expectId: number | string, sawAnyLine: boolean) {
    super(
      sawAnyLine
        ? `MCP RPC: 子进程在响应 id=${expectId} 前关闭了 stdout（已读到其它输出但无匹配 id）`
        : `MCP RPC: 子进程在响应 id=${expectId} 前关闭了 stdout（无任何输出）`
    );
    this.name = "McpStreamClosedError";
    this.expectId = expectId;
    this.sawAnyLine = sawAnyLine;
  }
}

export async function collectRpcResponse(
  lines: AsyncIterable<string>,
  expectId: number | string,
  timeoutMs: number
): Promise<JsonRpcResponse> {
  const deadline = Date.now() + timeoutMs;
  let sawAnyLine = false;
  let timedOut = false;
  for await (const line of lines) {
    sawAnyLine = true;
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const msg = parseJsonRpcLine(line);
    if (!msg) continue;
    if (msg.id === undefined || msg.id === null) continue;
    if (String(msg.id) !== String(expectId)) continue;
    return msg;
  }
  if (timedOut || Date.now() > deadline) {
    throw new Error(`MCP RPC timeout waiting for id=${expectId} (${timeoutMs}ms)`);
  }
  throw new McpStreamClosedError(expectId, sawAnyLine);
}
