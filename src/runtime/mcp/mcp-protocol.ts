/**
 * Shared MCP protocol-version helpers used by both client transports
 * (`http-transport.ts`, `stdio-session.ts`) and the two built-in servers
 * (`broker-mcp-server.ts`, `mcp-bridge-server.ts`).
 *
 * 列表按"优先尝试"顺序排列：新版本在前。客户端首选最新；如服务端在 `initialize`
 * 阶段拒绝（HTTP 400 / JSON-RPC error，message 含 "unsupported … protocol version"），
 * 我们按列表依次降级再试。
 *
 * 服务端侧：`negotiateServerProtocolVersion` 把客户端请求中的 `protocolVersion`
 * 与本地支持列表取交集，若不支持则回 fallback。
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type McpProtocolVersion = (typeof MCP_SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Default version used by client when no server-side hint exists. */
export const MCP_DEFAULT_PROTOCOL_VERSION: McpProtocolVersion = "2025-06-18";

/** Oldest version we keep around for backwards compat with legacy servers. */
export const MCP_LEGACY_PROTOCOL_VERSION: McpProtocolVersion = "2024-11-05";

export function isSupportedMcpProtocolVersion(v: unknown): v is McpProtocolVersion {
  return (
    typeof v === "string" && (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(v)
  );
}

/** Heuristic to detect "server rejected our protocolVersion" out of arbitrary error text. */
export function isUnsupportedProtocolVersionError(message: string | undefined | null): boolean {
  if (!message) return false;
  return (
    /unsupported.*mcp.*protocol.*version/i.test(message) ||
    /unsupported.*protocol.*version/i.test(message) ||
    /protocol.*version.*not.*supported/i.test(message)
  );
}

/**
 * Picks the protocolVersion we (acting as server) will echo back to the client.
 * 优先回客户端发来的版本（如果我们支持），否则用我们的默认版本。
 */
export function negotiateServerProtocolVersion(clientVersion: unknown): McpProtocolVersion {
  return isSupportedMcpProtocolVersion(clientVersion)
    ? clientVersion
    : MCP_DEFAULT_PROTOCOL_VERSION;
}
