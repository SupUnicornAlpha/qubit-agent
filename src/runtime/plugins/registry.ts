import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  mcpCatalog,
  mcpCatalogInstall,
  mcpServerConfig,
  skillMarketInstall,
} from "../../db/sqlite/schema";
import { syncServerDefaultStarBinding } from "../mcp/default-star-binding";
import {
  installCatalogItemToProject,
  listCatalogItemsPaginated,
  listProjectInstalls,
  uninstallProjectCatalogInstall,
} from "../mcp/market-service";
import { skillService } from "../skills/skill-service";
import { importAgentSkillPath } from "./import-agent-skills";
import { importClaudePluginDir } from "./import-claude";
import { importCodexPluginDir } from "./import-codex";
import { listConnectorAuthStatus } from "./oauth-service";
import {
  FUTU_CONNECTOR_PLUGIN_ID,
  getOfficialPluginPack,
  listOfficialPluginPacks,
} from "./official-packs";
import type {
  PluginListItem,
  PluginManifest,
  PluginOriginFormat,
} from "./types";
import { seedBrokerMcpServer } from "../seed-broker-mcp";

function riskToSafety(risk: string | null | undefined): "low" | "medium" | "high" {
  if (risk === "high") return "high";
  if (risk === "medium") return "medium";
  return "low";
}

function projectMcpAsPlugin(row: typeof mcpCatalogInstall.$inferSelect): PluginListItem {
  return {
    id: `mcp-install:${row.id}`,
    name: row.serverName,
    description: `MCP 安装（catalog=${row.catalogId}）`,
    category: "mcp",
    visibility: "project",
    kind: "mcp",
    ref: {
      mcpCatalogId: row.catalogId,
      mcpInstallId: row.id,
      mcpServerName: row.serverName,
    },
    auth: { type: "none" },
    safetyLevel: "medium",
    origin: { format: "mcp" },
    installed: row.installStatus === "installed",
    installKey: `mcp:${row.id}`,
    installStatus: row.installStatus,
    installedAt: row.createdAt,
  };
}

function projectSkillAsPlugin(row: typeof skillMarketInstall.$inferSelect): PluginListItem {
  const originFormat: PluginOriginFormat =
    row.registry.startsWith("import:codex")
      ? "codex_plugin"
      : row.registry.startsWith("import:claude")
        ? "claude_plugin"
        : row.registry.startsWith("import:agent_skills") || row.registry === "manual"
          ? "agent_skills"
          : "mcp";
  return {
    id: `skill-install:${row.id}`,
    name: row.skillName,
    description: row.description ?? "",
    category: "skills",
    visibility: "project",
    kind: "skill",
    ref: {
      skillInstallId: row.id,
      skillName: row.skillName,
    },
    auth: { type: "none" },
    safetyLevel: "low",
    origin: { format: originFormat === "mcp" ? "agent_skills" : originFormat },
    installed: row.installStatus === "installed",
    installKey: `skill:${row.id}`,
    installStatus: row.installStatus,
    installedAt: row.createdAt,
  };
}

function catalogRowAsPlugin(row: typeof mcpCatalog.$inferSelect): PluginListItem {
  return {
    id: `mcp-catalog:${row.id}`,
    name: row.name,
    version: row.version ?? undefined,
    description: row.description ?? "",
    category: "mcp",
    visibility: "public",
    kind: "mcp",
    ref: {
      mcpCatalogId: row.id,
      mcpServerName: row.slug || row.name,
    },
    auth: { type: "none" },
    safetyLevel: riskToSafety(row.riskLevel),
    origin: { format: "mcp" },
    installed: false,
  };
}

export async function listPlugins(input: {
  projectId?: string;
  q?: string;
  tab?: "featured" | "installed" | "catalog" | "all";
  page?: number;
  pageSize?: number;
}): Promise<{ items: PluginListItem[]; total: number; page: number; pageSize: number }> {
  const tab = input.tab ?? "all";
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 40));
  const q = (input.q ?? "").trim().toLowerCase();

  const items: PluginListItem[] = [];

  if (tab === "featured" || tab === "all") {
    for (const pack of listOfficialPluginPacks()) {
      items.push({
        ...pack,
        installed: true,
        installKey: pack.id,
        installStatus: "builtin",
      });
    }
  }

  if ((tab === "installed" || tab === "all") && input.projectId) {
    const mcpInstalls = await listProjectInstalls(input.projectId);
    for (const row of mcpInstalls) {
      if (row.installStatus === "removed") continue;
      items.push(projectMcpAsPlugin(row));
    }
    const db = await getDb();
    const skillRows = await db
      .select()
      .from(skillMarketInstall)
      .where(
        and(
          eq(skillMarketInstall.projectId, input.projectId),
          ne(skillMarketInstall.installStatus, "removed")
        )
      )
      .orderBy(desc(skillMarketInstall.createdAt));
    for (const row of skillRows) {
      items.push(projectSkillAsPlugin(row));
    }
  }

  if (tab === "catalog" || tab === "all") {
    const pageResult = await listCatalogItemsPaginated({
      page: 1,
      pageSize: 48,
      ...(input.q !== undefined ? { q: input.q } : {}),
    });
    for (const row of pageResult.items) {
      items.push(catalogRowAsPlugin(row));
    }
  }

  if (input.projectId) {
    try {
      const oauthRows = await listConnectorAuthStatus(input.projectId);
      const byPlugin = new Map(oauthRows.map((r) => [r.pluginId, r]));
      for (const item of items) {
        const st = byPlugin.get(item.id);
        if (!st) continue;
        item.oauthConnected = st.connected;
        item.oauthStatus = st.status;
        item.oauthExpiresAt = st.expiresAt;
        item.oauthError = st.errorMessage;
        item.oauthMcpServerName = st.mcpServerName;
        if (item.kind === "connector" && st.connected) {
          item.installed = true;
          item.installStatus = "connected";
        }
      }
    } catch {
      /* oauth table may not exist yet in mid-migrate tests */
    }
  }

  const filtered = q
    ? items.filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          i.description.toLowerCase().includes(q) ||
          i.id.toLowerCase().includes(q) ||
          i.kind.toLowerCase().includes(q)
      )
    : items;

  // Dedupe by id (official + catalog overlap unlikely; keep first)
  const seen = new Set<string>();
  const deduped: PluginListItem[] = [];
  for (const item of filtered) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  const total = deduped.length;
  const start = (page - 1) * pageSize;
  return {
    items: deduped.slice(start, start + pageSize),
    total,
    page,
    pageSize,
  };
}

export async function listInstalledPlugins(projectId: string): Promise<PluginListItem[]> {
  const { items } = await listPlugins({ projectId, tab: "installed", pageSize: 200 });
  const official = listOfficialPluginPacks().map((pack) => ({
    ...pack,
    installed: true,
    installKey: pack.id,
    installStatus: "builtin",
  }));
  return [...official, ...items];
}

async function upsertManualMcpServer(input: {
  projectId: string;
  name: string;
  command?: string;
  url?: string;
  transport?: "stdio" | "http" | "ws";
}): Promise<{ serverName: string; reused: boolean }> {
  const db = await getDb();
  const existing = await db
    .select()
    .from(mcpServerConfig)
    .where(and(eq(mcpServerConfig.projectId, input.projectId), eq(mcpServerConfig.name, input.name)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(mcpServerConfig)
      .set({
        command: input.command ?? existing[0].command,
        url: input.url ?? existing[0].url,
        transport: input.transport ?? existing[0].transport,
        enabled: true,
      })
      .where(eq(mcpServerConfig.id, existing[0].id));
    await syncServerDefaultStarBinding({
      serverName: input.name,
      projectId: input.projectId,
      enabled: true,
    });
    return { serverName: input.name, reused: true };
  }
  await db.insert(mcpServerConfig).values({
    id: randomUUID(),
    name: input.name,
    projectId: input.projectId,
    transport: input.transport ?? (input.url ? "http" : "stdio"),
    command: input.command ?? null,
    url: input.url ?? null,
    capabilitiesJson: null,
    enabled: true,
  });
  await syncServerDefaultStarBinding({
    serverName: input.name,
    projectId: input.projectId,
    enabled: true,
  });
  return { serverName: input.name, reused: false };
}

function normalizeMcpTransport(
  transport: string | undefined,
  url: string | undefined
): "stdio" | "http" | "ws" {
  if (transport === "stdio" || transport === "http" || transport === "ws") {
    return transport;
  }
  return url ? "http" : "stdio";
}

async function installSkillRows(input: {
  projectId: string;
  registry: string;
  skills: Array<{ name: string; description: string; bodyMd: string }>;
  installedBy?: string;
}): Promise<string[]> {
  const db = await getDb();
  const installIds: string[] = [];
  for (const skill of input.skills) {
    const externalSkillId = `${input.registry}:${skill.name}`;
    const existing = await db
      .select()
      .from(skillMarketInstall)
      .where(
        and(
          eq(skillMarketInstall.projectId, input.projectId),
          eq(skillMarketInstall.externalSkillId, externalSkillId)
        )
      )
      .limit(1);
    let installId = existing[0]?.id;
    if (!installId) {
      installId = randomUUID();
      await db.insert(skillMarketInstall).values({
        id: installId,
        projectId: input.projectId,
        registry: input.registry,
        externalSkillId,
        skillName: skill.name,
        description: skill.description,
        metaJson: JSON.stringify({ imported: true }),
        installStatus: "installed",
        installedBy: input.installedBy ?? "user",
      });
    } else if (existing[0]?.installStatus !== "installed") {
      await db
        .update(skillMarketInstall)
        .set({ installStatus: "installed" })
        .where(eq(skillMarketInstall.id, installId));
    }
    await skillService.mirrorFromMarketInstall(installId, { bodyMd: skill.bodyMd });
    installIds.push(installId);
  }
  return installIds;
}

export async function installPlugin(input: {
  projectId: string;
  /** mcp-catalog:<id> | builtin:<id> | skill market external id via kind */
  targetId: string;
  kind?: "mcp" | "skill" | "builtin_pack" | "connector";
  serverName?: string;
  externalSkillId?: string;
  installedBy?: string;
}): Promise<{ ok: true; item: PluginListItem; warnings?: string[] } | { ok: false; error: string }> {
  if (
    input.targetId === FUTU_CONNECTOR_PLUGIN_ID ||
    (input.kind === "connector" && input.targetId.includes("futu"))
  ) {
    const pack = getOfficialPluginPack(FUTU_CONNECTOR_PLUGIN_ID);
    if (!pack) return { ok: false, error: "futu connector pack missing" };
    const warnings: string[] = [];
    try {
      await seedBrokerMcpServer();
    } catch (e) {
      warnings.push(`seed qubit-broker MCP: ${(e as Error).message}`);
    }
    try {
      const { ensureDefaultFutuBrokerAccount, ensureFutuRuntime } = await import(
        "../market/futu-runtime"
      );
      await ensureDefaultFutuBrokerAccount();
      const runtime = await ensureFutuRuntime();
      warnings.push(runtime.message);
      if (!runtime.trade.healthy && runtime.openD?.mode !== "mock") {
        warnings.push(
          "交易桥未就绪：请确认 Python 依赖与 OpenD，或手动 python_connectors/broker_http_server.py"
        );
      }
      if (!runtime.marketWsUrl) {
        warnings.push("行情 WS 未设置：请安装 websockets/futu-api 后 POST /market/stream/bridges/futu/ensure");
      }
    } catch (e) {
      warnings.push(`ensure futu runtime: ${(e as Error).message}`);
    }
    return {
      ok: true,
      item: {
        ...pack,
        installed: true,
        installKey: pack.id,
        installStatus: "configured",
        warnings,
      },
      warnings,
    };
  }

  if (
    input.targetId.startsWith("builtin:") ||
    input.kind === "builtin_pack" ||
    input.targetId.startsWith("connector:")
  ) {
    const pack = getOfficialPluginPack(input.targetId);
    if (!pack) return { ok: false, error: `unknown builtin/connector pack: ${input.targetId}` };
    return {
      ok: true,
      item: {
        ...pack,
        installed: true,
        installKey: pack.id,
        installStatus: "builtin",
      },
      warnings: ["官方 pack 已内置/已登记，无需重复安装。"],
    };
  }

  if (input.targetId.startsWith("mcp-catalog:") || input.kind === "mcp") {
    const catalogId = input.targetId.replace(/^mcp-catalog:/, "");
    const db = await getDb();
    const rows = await db.select().from(mcpCatalog).where(eq(mcpCatalog.id, catalogId)).limit(1);
    const cat = rows[0];
    if (!cat) return { ok: false, error: `mcp catalog not found: ${catalogId}` };
    const serverName = (input.serverName ?? cat.slug ?? cat.name).trim();
    const install = await installCatalogItemToProject({
      projectId: input.projectId,
      catalogItemId: catalogId,
      serverName,
      installedBy: input.installedBy ?? "user",
      ...(cat.command ? { command: cat.command } : {}),
      ...(cat.url ? { url: cat.url } : {}),
      ...(cat.defaultToolName ? { toolName: cat.defaultToolName } : {}),
      ...(cat.defaultTimeoutMs ? { timeoutMs: cat.defaultTimeoutMs } : {}),
    });
    return { ok: true, item: projectMcpAsPlugin(install) };
  }

  if (input.kind === "skill" || input.externalSkillId) {
    return {
      ok: false,
      error: "请使用 Skill 市场直装（轨 B）或 /plugins/import；本接口暂不代理远程 skill 拉取。",
    };
  }

  return { ok: false, error: `unsupported target: ${input.targetId}` };
}

export async function uninstallPlugin(input: {
  projectId: string;
  installKey: string;
}): Promise<{ ok: true; message: string } | { ok: false; error: string; status?: number }> {
  const key = input.installKey;
  if (key === "builtin:internet" || key === "builtin:quant-data" || key.startsWith("builtin:")) {
    return { ok: false, error: "官方 builtin pack 不可卸载", status: 400 };
  }
  if (key.startsWith("mcp:")) {
    const installId = key.slice("mcp:".length);
    await uninstallProjectCatalogInstall({ installId, projectId: input.projectId });
    return { ok: true, message: "mcp uninstalled" };
  }
  if (key.startsWith("skill:")) {
    const installId = key.slice("skill:".length);
    const db = await getDb();
    const rows = await db
      .select()
      .from(skillMarketInstall)
      .where(
        and(eq(skillMarketInstall.id, installId), eq(skillMarketInstall.projectId, input.projectId))
      )
      .limit(1);
    if (!rows[0]) return { ok: false, error: "skill install not found", status: 404 };
    await db.delete(skillMarketInstall).where(eq(skillMarketInstall.id, installId));
    // Keep agent_skill row for history; mirror link is informational.
    return { ok: true, message: "skill install removed" };
  }
  return { ok: false, error: `unknown installKey: ${key}`, status: 400 };
}

export async function importPluginPackage(input: {
  projectId: string;
  format: "codex_plugin" | "claude_plugin" | "agent_skills";
  rootPath: string;
  installedBy?: string;
}): Promise<{
  ok: true;
  manifest: PluginManifest;
  skillInstallIds: string[];
  mcpServerNames: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  let skills: Array<{ name: string; description: string; bodyMd: string }> = [];
  let mcpServers: NonNullable<PluginManifest["ref"]["mcpServers"]> = [];
  let manifest: PluginManifest;

  if (input.format === "agent_skills") {
    const skill = await importAgentSkillPath(input.rootPath);
    skills = [skill];
    manifest = {
      id: `import:agent_skills:${skill.name}`,
      name: skill.name,
      description: skill.description,
      category: "imported",
      visibility: "project",
      kind: "skill",
      ref: { skillName: skill.name },
      auth: { type: "none" },
      safetyLevel: "low",
      origin: { format: "agent_skills", sourcePath: input.rootPath },
    };
  } else if (input.format === "codex_plugin") {
    const r = await importCodexPluginDir(input.rootPath);
    skills = r.skills;
    mcpServers = r.mcpServers;
    manifest = r.manifest;
    warnings.push(...r.warnings);
  } else {
    const r = await importClaudePluginDir(input.rootPath);
    skills = r.skills;
    mcpServers = r.mcpServers;
    manifest = r.manifest;
    warnings.push(...r.warnings);
  }

  const registry =
    input.format === "codex_plugin"
      ? "import:codex_plugin"
      : input.format === "claude_plugin"
        ? "import:claude_plugin"
        : "import:agent_skills";

  const skillInstallIds = await installSkillRows({
    projectId: input.projectId,
    registry,
    skills,
    ...(input.installedBy !== undefined ? { installedBy: input.installedBy } : {}),
  });

  const mcpServerNames: string[] = [];
  for (const server of mcpServers) {
    const name = server.name.trim();
    if (!name) continue;
    await upsertManualMcpServer({
      projectId: input.projectId,
      name,
      ...(server.command !== undefined ? { command: server.command } : {}),
      ...(server.url !== undefined ? { url: server.url } : {}),
      transport: normalizeMcpTransport(server.transport, server.url),
    });
    // Audit row so Plugins「已安装」能投影到 MCP 轨（无 catalog 时写一条 synthetic install）
    await ensureSyntheticMcpInstall({
      projectId: input.projectId,
      serverName: name,
      installedBy: input.installedBy ?? "user",
      origin: registry,
    });
    mcpServerNames.push(name);
  }

  return {
    ok: true,
    manifest,
    skillInstallIds,
    mcpServerNames,
    warnings,
  };
}

async function ensureSyntheticMcpInstall(input: {
  projectId: string;
  serverName: string;
  installedBy: string;
  origin: string;
}): Promise<void> {
  const db = await getDb();
  // Prefer a real catalog match by slug/name; else skip catalog_install (server_config is enough).
  const cats = await db
    .select()
    .from(mcpCatalog)
    .where(eq(mcpCatalog.slug, input.serverName))
    .limit(1);
  if (!cats[0]) return;
  const existing = await db
    .select()
    .from(mcpCatalogInstall)
    .where(
      and(
        eq(mcpCatalogInstall.projectId, input.projectId),
        eq(mcpCatalogInstall.serverName, input.serverName),
        eq(mcpCatalogInstall.catalogId, cats[0].id)
      )
    )
    .limit(1);
  if (existing[0]) {
    if (existing[0].installStatus !== "installed") {
      await db
        .update(mcpCatalogInstall)
        .set({ installStatus: "installed", status: "installed" })
        .where(eq(mcpCatalogInstall.id, existing[0].id));
    }
    return;
  }
  await db.insert(mcpCatalogInstall).values({
    id: randomUUID(),
    projectId: input.projectId,
    workspaceId: null,
    sourceId: cats[0].sourceId,
    catalogId: cats[0].id,
    serverName: input.serverName,
    status: "installed",
    installStatus: "installed",
    errorMessage: null,
    installedBy: `${input.installedBy}:${input.origin}`,
  });
}
