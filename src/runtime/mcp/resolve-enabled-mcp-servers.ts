import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpServerConfig } from "../../db/sqlite/schema";

/**
 * 仅保留已在 mcp_server_config 中注册且 enabled 的服务名。
 * 避免将 qubit-news 等 connector 名或未启用的 fsi-* 写入 Agent 的 MCP 白名单。
 */
export async function resolveEnabledMcpServerNames(names: string[]): Promise<string[]> {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return [];

  const db = await getDb();
  const rows = await db
    .select({ name: mcpServerConfig.name })
    .from(mcpServerConfig)
    .where(
      and(
        eq(mcpServerConfig.enabled, true),
        isNull(mcpServerConfig.projectId),
        inArray(mcpServerConfig.name, unique)
      )
    );

  const enabled = new Set(rows.map((r) => r.name));
  return unique.filter((n) => enabled.has(n));
}
