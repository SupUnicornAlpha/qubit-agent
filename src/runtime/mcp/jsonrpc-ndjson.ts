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

export async function collectRpcResponse(
  lines: AsyncIterable<string>,
  expectId: number | string,
  timeoutMs: number
): Promise<JsonRpcResponse> {
  const deadline = Date.now() + timeoutMs;
  for await (const line of lines) {
    if (Date.now() > deadline) break;
    const msg = parseJsonRpcLine(line);
    if (!msg) continue;
    if (msg.id === undefined || msg.id === null) continue;
    if (String(msg.id) !== String(expectId)) continue;
    return msg;
  }
  throw new Error(`MCP RPC timeout waiting for id=${expectId}`);
}
