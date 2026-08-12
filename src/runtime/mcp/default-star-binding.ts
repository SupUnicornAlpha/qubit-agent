/**
 * MCP「配完即用」：启用的 server 自动持有 toolName="*" 默认 binding。
 *
 * 语义：
 *   - `*` = 整个 server 的默认策略（timeout/retry）；精确 tool 行仍可覆盖
 *   - server enabled=true  → 确保 `*` 存在且 enabled
 *   - server enabled=false → 将同作用域 `*` 设为 disabled（不删行）
 *   - 不覆盖已有行的 timeout/retry/rateLimit（仅创建时可用 opts）
 */

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../../db/sqlite/client";
import { mcpToolBinding } from "../../db/sqlite/schema";

export const MCP_WILDCARD_TOOL = "*";

export type SyncServerDefaultStarBindingInput = {
  serverName: string;
  projectId?: string | null;
  /** 与 mcp_server_config.enabled 对齐 */
  enabled: boolean;
  /** 仅在新建 `*` 行时写入；已有行不覆盖 */
  timeoutMs?: number | null;
};

export type SyncServerDefaultStarBindingResult = {
  created: boolean;
  updated: boolean;
  bindingId: string | null;
};

function projectScope(projectId?: string | null) {
  return projectId ? eq(mcpToolBinding.projectId, projectId) : isNull(mcpToolBinding.projectId);
}

/**
 * 为指定 server（+ project 作用域、definitionId=null）同步通配 binding。
 */
export async function syncServerDefaultStarBinding(
  input: SyncServerDefaultStarBindingInput
): Promise<SyncServerDefaultStarBindingResult> {
  const serverName = input.serverName.trim();
  if (!serverName) {
    return { created: false, updated: false, bindingId: null };
  }

  const db = await getDb();
  const projectId = input.projectId ?? null;
  const existing = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, serverName),
        eq(mcpToolBinding.toolName, MCP_WILDCARD_TOOL),
        projectScope(projectId),
        isNull(mcpToolBinding.definitionId)
      )
    )
    .limit(1);

  const row = existing[0];
  if (!row) {
    if (!input.enabled) {
      return { created: false, updated: false, bindingId: null };
    }
    const id = randomUUID();
    await db.insert(mcpToolBinding).values({
      id,
      projectId,
      definitionId: null,
      serverName,
      toolName: MCP_WILDCARD_TOOL,
      enabled: true,
      timeoutMs: input.timeoutMs ?? null,
    });
    return { created: true, updated: false, bindingId: id };
  }

  if (row.enabled === input.enabled) {
    return { created: false, updated: false, bindingId: row.id };
  }

  await db
    .update(mcpToolBinding)
    .set({ enabled: input.enabled, updatedAt: new Date().toISOString() })
    .where(eq(mcpToolBinding.id, row.id));
  return { created: false, updated: true, bindingId: row.id };
}
