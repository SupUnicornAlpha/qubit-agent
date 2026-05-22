/**
 * MCP server 来源派生（"内置 / 市场 / 手动"）
 *
 * 背景：`mcp_server_config` 表自身没有 origin 字段。来源信息散落在三处：
 *   - seed-recommended-mcp-servers.ts 内置白名单（mathjs / tradingcalc / mcp-financex / fmp-mcp）
 *   - seed-broker-mcp.ts 内置 broker（qubit-broker）
 *   - mcp_catalog_install 表（用户从市场安装的 server）
 *
 * 在多个 API 返回 / 多个前端组件里重复推导很乱，集中到这里。
 *
 * 派生规则（按优先级）：
 *   1. 在 mcp_catalog_install 里存在同名记录 → 'market'
 *   2. 否则 name ∈ 内置白名单且 projectId === null → 'builtin'
 *   3. 其它 → 'manual'（用户在"快速添加 MCP SERVER"表单手填）
 */

import { RECOMMENDED_MCP_NAMES } from "../seed-recommended-mcp-servers";
import { QUBIT_BROKER_MCP_NAME } from "../seed-broker-mcp";

export type McpServerOrigin = "builtin" | "market" | "manual";

const BUILTIN_MCP_NAMES = new Set<string>([
  ...Object.values(RECOMMENDED_MCP_NAMES),
  QUBIT_BROKER_MCP_NAME,
]);

/**
 * `mcp_server_config.capabilities_json` 里可能携带的 `source` 标签集合。
 * seed-fsi-integration / 其它内置 seed 写入时会标这个值，用来识别"项目自带"的
 * MCP，避免落到 'manual'（看起来像用户手填）。
 */
const BUILTIN_CAPABILITY_SOURCES = new Set<string>([
  "anthropic-fsi-catalog",
  "builtin",
]);

export interface McpServerOriginInput {
  name: string;
  projectId: string | null;
  /** mcp_server_config.capabilities_json，可能是任意 JSON */
  capabilitiesJson?: unknown;
}

function hasBuiltinCapabilitySource(caps: unknown): boolean {
  if (!caps || typeof caps !== "object") return false;
  const src = (caps as { source?: unknown }).source;
  return typeof src === "string" && BUILTIN_CAPABILITY_SOURCES.has(src);
}

/**
 * 派生单个 server 的 origin。
 * @param server          要判定的 server config
 * @param marketServerNames market 安装记录中所有 (projectId, serverName) 的 serverName 集合
 */
export function deriveMcpServerOrigin(
  server: McpServerOriginInput,
  marketServerNames: ReadonlySet<string>
): McpServerOrigin {
  if (marketServerNames.has(server.name)) return "market";
  if (server.projectId === null) {
    if (BUILTIN_MCP_NAMES.has(server.name)) return "builtin";
    if (hasBuiltinCapabilitySource(server.capabilitiesJson)) return "builtin";
  }
  return "manual";
}

/** 内置 MCP server 名集合（外部需要直接判定时使用） */
export function getBuiltinMcpServerNames(): ReadonlySet<string> {
  return BUILTIN_MCP_NAMES;
}
