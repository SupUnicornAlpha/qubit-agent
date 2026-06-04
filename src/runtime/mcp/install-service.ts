/**
 * Self-Evolving Agent P9 — MCP 自装配 service。
 *
 * 把 `agentRouter.post("/mcp/catalog/install", ...)` 的纯 DB 逻辑抽成独立 service，
 * 让 AutoInstaller auto 模式 / 任意 worker 都能不依赖 hono context 直接调。
 *
 * 设计：
 *   - 接 catalogId 必传；其它字段全 optional，回 catalog 默认值
 *   - upsert mcp_server_config + mcp_tool_binding（serverName + null definitionId）
 *   - 写 mcp_catalog_install 一行（auditing；installedBy 传 'user' / 'auto_installer'）
 *   - 不真去 spawn server / ping —— P9 范围只到"写 binding 让 mcp tool 解析路径生效"
 *
 * 错误：
 *   - catalog 不存在 → `CatalogNotFoundError`（前端 / 路由翻译 404）
 *   - 其它 db 错原样抛
 */

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";

import { getDb } from "../../db/sqlite/client.js";
import {
  mcpCatalog,
  mcpCatalogInstall,
  mcpServerConfig,
  mcpToolBinding,
} from "../../db/sqlite/schema.js";

export class CatalogNotFoundError extends Error {
  constructor(catalogId: string) {
    super(`mcp_catalog not found: ${catalogId}`);
    this.name = "CatalogNotFoundError";
  }
}

export interface InstallMcpCatalogInput {
  catalogId: string;
  serverName: string;
  command?: string | null;
  url?: string | null;
  toolName?: string;
  timeoutMs?: number;
  installedBy?: string;
}

export interface InstallMcpCatalogResult {
  installId: string;
  catalogId: string;
  catalogSlug: string;
  serverName: string;
  toolName: string;
  installedBy: string;
  reusedServer: boolean;
  reusedBinding: boolean;
}

export async function installMcpCatalogToProject(
  input: InstallMcpCatalogInput
): Promise<InstallMcpCatalogResult> {
  if (!input.catalogId) throw new Error("catalogId required");
  if (!input.serverName) throw new Error("serverName required");

  const db = await getDb();
  const rows = await db
    .select()
    .from(mcpCatalog)
    .where(eq(mcpCatalog.id, input.catalogId))
    .limit(1);
  const catalog = rows[0];
  if (!catalog) throw new CatalogNotFoundError(input.catalogId);

  const serverName = input.serverName.trim();
  const command = input.command ?? catalog.command;
  const url = input.url ?? catalog.url;

  // ── upsert mcp_server_config ──
  const existingServer = await db
    .select()
    .from(mcpServerConfig)
    .where(eq(mcpServerConfig.name, serverName))
    .limit(1);
  let reusedServer = false;
  if (existingServer[0]) {
    reusedServer = true;
    await db
      .update(mcpServerConfig)
      .set({
        transport: catalog.transport,
        command,
        url,
        capabilitiesJson: catalog.defaultCapabilitiesJson,
        enabled: true,
      })
      .where(eq(mcpServerConfig.id, existingServer[0].id));
  } else {
    await db.insert(mcpServerConfig).values({
      id: randomUUID(),
      name: serverName,
      transport: catalog.transport,
      command,
      url,
      capabilitiesJson: catalog.defaultCapabilitiesJson,
      enabled: true,
    });
  }

  // ── upsert mcp_tool_binding (server + tool + definitionId=null) ──
  const toolName = (input.toolName ?? "").trim() || catalog.defaultToolName || "ping";
  const existingBinding = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, serverName),
        eq(mcpToolBinding.toolName, toolName),
        isNull(mcpToolBinding.definitionId)
      )
    )
    .limit(1);
  let reusedBinding = false;
  if (existingBinding[0]) {
    reusedBinding = true;
    await db
      .update(mcpToolBinding)
      .set({
        enabled: true,
        timeoutMs: input.timeoutMs ?? catalog.defaultTimeoutMs,
        retryPolicyJson: catalog.defaultRetryPolicyJson,
        rateLimitJson: catalog.defaultRateLimitJson,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mcpToolBinding.id, existingBinding[0].id));
  } else {
    await db.insert(mcpToolBinding).values({
      id: randomUUID(),
      serverName,
      toolName,
      definitionId: null,
      enabled: true,
      timeoutMs: input.timeoutMs ?? catalog.defaultTimeoutMs,
      retryPolicyJson: catalog.defaultRetryPolicyJson,
      rateLimitJson: catalog.defaultRateLimitJson,
    });
  }

  // ── 写 audit 行 mcp_catalog_install ──
  const installId = randomUUID();
  const installedBy = input.installedBy ?? "user";
  await db.insert(mcpCatalogInstall).values({
    id: installId,
    catalogId: catalog.id,
    serverName,
    status: "installed",
    installedBy,
  });

  return {
    installId,
    catalogId: catalog.id,
    catalogSlug: catalog.slug,
    serverName,
    toolName,
    installedBy,
    reusedServer,
    reusedBinding,
  };
}
