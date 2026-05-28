import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpServerConfig } from "../../db/sqlite/schema";

/**
 * 单个 MCP server 在 capabilities_json.tools 里登记的工具元数据。
 * 这部分是**静态注入**（写在 seed 或 migration 里）的清单，
 * dispatcher 可在运行时通过 ListTools 进一步刷新填充（详见 dispatcher.ts）。
 */
export type McpToolDescriptor = {
  name: string;
  desc?: string;
};

export type EnabledMcpServerInfo = {
  name: string;
  /** capabilities_json.tools 注入的真实工具清单；为空表示尚未注入 */
  tools?: McpToolDescriptor[];
};

function parseTools(raw: unknown): McpToolDescriptor[] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const toolsRaw = (raw as Record<string, unknown>)["tools"];
  if (!Array.isArray(toolsRaw)) return undefined;
  const out: McpToolDescriptor[] = [];
  for (const item of toolsRaw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj["name"] === "string" ? obj["name"].trim() : "";
    if (!name) continue;
    const desc = typeof obj["desc"] === "string" ? obj["desc"] : undefined;
    out.push(desc ? { name, desc } : { name });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 仅保留已在 mcp_server_config 中注册且 enabled 的服务名。
 * 避免将 qubit-news 等 connector 名或未启用的 fsi-* 写入 Agent 的 MCP 白名单。
 */
export async function resolveEnabledMcpServerNames(names: string[]): Promise<string[]> {
  const enabled = await resolveEnabledMcpServers(names);
  return enabled.map((s) => s.name);
}

/**
 * 返回 enabled MCP server 列表 + 每个 server 真实工具清单。
 *
 * prompt 拼装层（buildAgentToolsPromptBlock）用 tools 字段告诉 LLM
 * 每个 server 真实暴露的工具名，避免 LLM 凭训练记忆瞎喊
 * `get_financials / list_available_tools` 这种不存在的工具。
 */
export async function resolveEnabledMcpServers(names: string[]): Promise<EnabledMcpServerInfo[]> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return [];

  const db = await getDb();
  const rows = await db
    .select({
      name: mcpServerConfig.name,
      capabilitiesJson: mcpServerConfig.capabilitiesJson,
    })
    .from(mcpServerConfig)
    .where(
      and(
        eq(mcpServerConfig.enabled, true),
        isNull(mcpServerConfig.projectId),
        inArray(mcpServerConfig.name, unique)
      )
    );

  const byName = new Map<string, EnabledMcpServerInfo>();
  for (const row of rows) {
    const tools = parseTools(row.capabilitiesJson);
    byName.set(row.name, tools ? { name: row.name, tools } : { name: row.name });
  }
  return unique.filter((n) => byName.has(n)).map((n) => byName.get(n)!);
}
