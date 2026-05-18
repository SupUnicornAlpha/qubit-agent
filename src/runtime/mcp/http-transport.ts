import type { JsonRpcResponse } from "./jsonrpc-ndjson";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const MCP_ACCEPT = "application/json, text/event-stream";

type HttpSession = { sessionId?: string; initialized: boolean };

const httpSessions = new Map<string, HttpSession>();

function sessionCacheKey(postUrl: string, headers: Record<string, string>): string {
  return `${postUrl}::${JSON.stringify(headers)}`;
}

function nextRpcId(): number {
  return Math.floor(Math.random() * 1e9);
}

function parseJsonRpcMessages(raw: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return out;
  try {
    const single = JSON.parse(trimmed) as JsonRpcResponse;
    if (single && typeof single === "object") {
      out.push(single);
      return out;
    }
  } catch {
    // fall through — SSE or NDJSON
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const payload = t.startsWith("data:") ? t.slice(t.indexOf(":") + 1).trim() : t;
    if (!payload || payload === "[DONE]") continue;
    try {
      const msg = JSON.parse(payload) as JsonRpcResponse;
      if (msg && typeof msg === "object") out.push(msg);
    } catch {
      // ignore non-json lines
    }
  }
  return out;
}

function pickRpcById(messages: JsonRpcResponse[], id: number | string): JsonRpcResponse | undefined {
  return messages.find((m) => m.id !== undefined && m.id !== null && String(m.id) === String(id));
}

async function readHttpRpcResponse(res: Response, expectId: number | string): Promise<JsonRpcResponse> {
  if (res.status === 202) {
    return { jsonrpc: "2.0", id: expectId, result: {} };
  }
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text.trim()) {
    if (res.ok) return { jsonrpc: "2.0", id: expectId, result: {} };
    throw new Error(`MCP HTTP ${res.status}: empty body`);
  }
  const messages = parseJsonRpcMessages(text);
  const match = pickRpcById(messages, expectId);
  if (match) return match;
  if (messages.length === 1 && messages[0]) return messages[0]!;
  throw new Error(`MCP HTTP ${res.status}: no JSON-RPC response for id=${expectId}: ${text.slice(0, 500)}`);
}

async function mcpHttpPost(input: {
  postUrl: string;
  body: Record<string, unknown> | Record<string, unknown>[];
  headers?: Record<string, string>;
  sessionId?: string;
  timeoutMs?: number;
  expectId?: number | string;
}): Promise<{ rpc: JsonRpcResponse; sessionId?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 60_000);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Accept: MCP_ACCEPT,
      ...input.headers,
    };
    if (input.sessionId) headers["Mcp-Session-Id"] = input.sessionId;

    const res = await fetch(input.postUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(input.body),
      signal: ctrl.signal,
    });

    const responseSessionId = res.headers.get("Mcp-Session-Id") ?? undefined;

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${errText.slice(0, 800) || res.statusText}`);
    }

    if (input.expectId === undefined) {
      return { rpc: { jsonrpc: "2.0", result: {} }, sessionId: responseSessionId };
    }
    const rpc = await readHttpRpcResponse(res, input.expectId);
    return { rpc, sessionId: responseSessionId };
  } finally {
    clearTimeout(timer);
  }
}

async function ensureHttpSession(input: {
  postUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<string | undefined> {
  const hdrs = input.headers ?? {};
  const key = sessionCacheKey(input.postUrl, hdrs);
  const cached = httpSessions.get(key);
  if (cached?.initialized) return cached.sessionId;

  const initId = nextRpcId();
  const { rpc: initRes, sessionId } = await mcpHttpPost({
    postUrl: input.postUrl,
    headers: hdrs,
    timeoutMs: input.timeoutMs,
    expectId: initId,
    body: {
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "qubit-agent", version: "0.1.0" },
      },
    },
  });
  if (initRes.error) throw new Error(`MCP initialize failed: ${initRes.error.message}`);

  await mcpHttpPost({
    postUrl: input.postUrl,
    headers: hdrs,
    sessionId,
    timeoutMs: input.timeoutMs,
    body: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
  }).catch(() => undefined);

  const session: HttpSession = { initialized: true, sessionId };
  httpSessions.set(key, session);
  return sessionId;
}

export async function callMcpHttpTool(input: {
  postUrl: string;
  toolName: string;
  arguments: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<unknown> {
  const hdrs = input.headers ?? {};
  const sessionId = await ensureHttpSession({
    postUrl: input.postUrl,
    headers: hdrs,
    timeoutMs: input.timeoutMs,
  });

  const callId = nextRpcId();
  const { rpc } = await mcpHttpPost({
    postUrl: input.postUrl,
    headers: hdrs,
    sessionId,
    timeoutMs: input.timeoutMs,
    expectId: callId,
    body: {
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: {
        name: input.toolName,
        arguments: input.arguments ?? {},
      },
    },
  });
  if (rpc.error) throw new Error(rpc.error.message);
  return rpc.result;
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

/** Clears cached HTTP MCP sessions (for tests). */
export function resetMcpHttpSessionsForTest(): void {
  httpSessions.clear();
}
