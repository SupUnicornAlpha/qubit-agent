import type { JsonRpcResponse } from "./jsonrpc-ndjson";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function callMcpHttpTool(input: {
  postUrl: string;
  toolName: string;
  arguments: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<unknown> {
  const id = Math.floor(Math.random() * 1e9);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 60_000);
  try {
    const body = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: input.toolName,
        arguments: input.arguments ?? {},
      },
    };
    const res = await fetch(input.postUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json",
        ...input.headers,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = (await res.json().catch(() => ({}))) as JsonRpcResponse | Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`MCP HTTP ${res.status}: ${JSON.stringify(raw)}`);
    }
    const rpc = raw as JsonRpcResponse;
    if (rpc.error) throw new Error(rpc.error.message);
    return rpc.result;
  } finally {
    clearTimeout(timer);
  }
}

export function httpEndpointFromServer(url: string | null | undefined, caps: unknown): string {
  const c = asRecord(caps);
  const path = typeof c?.httpPath === "string" ? c.httpPath : "";
  const base = (url ?? "").replace(/\/$/, "");
  if (!base) throw new Error("MCP HTTP: mcp_server_config.url is required");
  if (path) return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  return base;
}

export function httpHeadersFromCaps(caps: unknown): Record<string, string> {
  const c = asRecord(caps);
  const h = c?.httpHeaders;
  if (!h || typeof h !== "object" || Array.isArray(h)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
