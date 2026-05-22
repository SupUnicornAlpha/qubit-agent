import type { JsonRpcResponse } from "./jsonrpc-ndjson";
import {
  MCP_DEFAULT_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type McpProtocolVersion,
  isSupportedMcpProtocolVersion,
  isUnsupportedProtocolVersionError,
} from "./mcp-protocol";

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const MCP_ACCEPT = "application/json, text/event-stream";

type HttpSession = {
  sessionId?: string | undefined;
  initialized: boolean;
  protocolVersion: McpProtocolVersion;
};

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

function pickRpcById(
  messages: JsonRpcResponse[],
  id: number | string
): JsonRpcResponse | undefined {
  return messages.find((m) => m.id !== undefined && m.id !== null && String(m.id) === String(id));
}

async function readHttpRpcResponse(
  res: Response,
  expectId: number | string
): Promise<JsonRpcResponse> {
  if (res.status === 202) {
    return { jsonrpc: "2.0", id: expectId, result: {} };
  }
  const text = await res.text();
  if (!text.trim()) {
    if (res.ok) return { jsonrpc: "2.0", id: expectId, result: {} };
    throw new Error(`MCP HTTP ${res.status}: empty body`);
  }
  const messages = parseJsonRpcMessages(text);
  const match = pickRpcById(messages, expectId);
  if (match) return match;
  if (messages.length === 1 && messages[0]) return messages[0];
  throw new Error(
    `MCP HTTP ${res.status}: no JSON-RPC response for id=${expectId}: ${text.slice(0, 500)}`
  );
}

/**
 * Build the 405 error message with actionable hints, mentioning both common
 * root causes (wrong endpoint path / legacy SSE-only server).
 */
function build405Hint(url: string, body: string): string {
  const sample = body.slice(0, 300);
  return [
    "MCP HTTP 405: 服务器拒绝 POST。",
    `请求地址: ${url}`,
    "常见原因：",
    "  1) 端点路径未配置。许多 MCP 服务真正的 endpoint 是 /mcp 或 /api/mcp，请在 mcp_server_config.capabilitiesJson.httpPath 里填上正确子路径；",
    "  2) 服务端只支持旧版 SSE 协议（GET /sse + POST /messages）。qubit-agent 当前仅支持 Streamable HTTP，请联系服务方提供新版 HTTP 端点，或暂时改用 stdio。",
    sample ? `原始响应: ${sample}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type HttpPostInput = {
  postUrl: string;
  body: Record<string, unknown> | Record<string, unknown>[];
  headers?: Record<string, string> | undefined;
  sessionId?: string | undefined;
  timeoutMs?: number | undefined;
  expectId?: number | string | undefined;
  /** When true, do not auto-translate 405 into hint text (the caller will). */
  raw405?: boolean | undefined;
};

async function mcpHttpPost(
  input: HttpPostInput
): Promise<{ rpc: JsonRpcResponse; sessionId?: string | undefined; status: number }> {
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
      if (res.status === 405 && !input.raw405) {
        throw new Error(build405Hint(input.postUrl, errText));
      }
      throw new Error(`MCP HTTP ${res.status}: ${errText.slice(0, 800) || res.statusText}`);
    }

    if (input.expectId === undefined) {
      return {
        rpc: { jsonrpc: "2.0", result: {} },
        sessionId: responseSessionId,
        status: res.status,
      };
    }
    const rpc = await readHttpRpcResponse(res, input.expectId);
    return { rpc, sessionId: responseSessionId, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try to initialize against `postUrl` with each supported protocolVersion in turn.
 * Returns the negotiated version + sessionId, or throws after exhausting list.
 */
async function tryInitializeAcrossVersions(input: {
  postUrl: string;
  headers: Record<string, string>;
  timeoutMs?: number | undefined;
}): Promise<{ sessionId: string | undefined; protocolVersion: McpProtocolVersion }> {
  let lastError: unknown;
  for (const ver of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
    const initId = nextRpcId();
    try {
      const { rpc: initRes, sessionId } = await mcpHttpPost({
        postUrl: input.postUrl,
        headers: input.headers,
        timeoutMs: input.timeoutMs,
        expectId: initId,
        body: {
          jsonrpc: "2.0",
          id: initId,
          method: "initialize",
          params: {
            protocolVersion: ver,
            capabilities: {},
            clientInfo: { name: "qubit-agent", version: "0.1.0" },
          },
        },
      });
      if (initRes.error) {
        const msg = initRes.error.message ?? "";
        if (isUnsupportedProtocolVersionError(msg)) {
          lastError = new Error(msg);
          continue;
        }
        throw new Error(`MCP initialize failed: ${msg}`);
      }
      const serverVer = asRecord(initRes.result)?.protocolVersion;
      const negotiated = isSupportedMcpProtocolVersion(serverVer) ? serverVer : ver;
      return { sessionId, protocolVersion: negotiated };
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
    `MCP initialize failed: 服务端拒绝了我们支持的全部 protocolVersion (${MCP_SUPPORTED_PROTOCOL_VERSIONS.join(", ")})。最后一次错误: ${last}`
  );
}

async function ensureHttpSession(input: {
  postUrl: string;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
}): Promise<HttpSession> {
  const hdrs = input.headers ?? {};
  const key = sessionCacheKey(input.postUrl, hdrs);
  const cached = httpSessions.get(key);
  if (cached?.initialized) return cached;

  const { sessionId, protocolVersion } = await tryInitializeAcrossVersions({
    postUrl: input.postUrl,
    headers: hdrs,
    timeoutMs: input.timeoutMs,
  });

  await mcpHttpPost({
    postUrl: input.postUrl,
    headers: { ...hdrs, "MCP-Protocol-Version": protocolVersion },
    sessionId,
    timeoutMs: input.timeoutMs,
    body: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
  }).catch(() => undefined);

  const session: HttpSession = { initialized: true, sessionId, protocolVersion };
  httpSessions.set(key, session);
  return session;
}

/** Auto-retry with `/mcp` appended when the original endpoint returns 405 and no httpPath was set. */
function alternateUrlForRetry(postUrl: string): string | undefined {
  const u = postUrl.replace(/\/$/, "");
  if (/\/mcp$/i.test(u)) return undefined;
  return `${u}/mcp`;
}

export async function callMcpHttpTool(input: {
  postUrl: string;
  toolName: string;
  arguments: Record<string, unknown>;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
}): Promise<unknown> {
  const hdrs = input.headers ?? {};

  let session: HttpSession;
  let effectivePostUrl = input.postUrl;
  try {
    session = await ensureHttpSession({
      postUrl: effectivePostUrl,
      headers: hdrs,
      timeoutMs: input.timeoutMs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const alt = alternateUrlForRetry(effectivePostUrl);
    if (alt && msg.includes("MCP HTTP 405")) {
      console.warn(`[mcp http] 405 on ${effectivePostUrl}; retrying once with ${alt}`);
      effectivePostUrl = alt;
      session = await ensureHttpSession({
        postUrl: effectivePostUrl,
        headers: hdrs,
        timeoutMs: input.timeoutMs,
      });
    } else {
      throw e;
    }
  }

  const callId = nextRpcId();
  const { rpc } = await mcpHttpPost({
    postUrl: effectivePostUrl,
    headers: { ...hdrs, "MCP-Protocol-Version": session.protocolVersion },
    sessionId: session.sessionId,
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

export { MCP_DEFAULT_PROTOCOL_VERSION };
