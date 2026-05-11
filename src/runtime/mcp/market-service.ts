import { randomUUID } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  mcpCatalog,
  mcpCatalogInstall,
  mcpCatalogItem,
  mcpRegistrySource,
  mcpServerConfig,
  mcpToolBinding,
  project,
} from "../../db/sqlite/schema";
import { dispatchMcpToolCall } from "./dispatcher";
import { ensureDefaultRegistrySource, listRegistrySources, syncRegistrySource } from "./registry-sync";

type InstallSpec = {
  command?: string;
  url?: string;
  defaultToolName?: string;
  defaultTimeoutMs?: number;
  defaultRetryPolicyJson?: Record<string, unknown>;
  defaultRateLimitJson?: Record<string, unknown>;
  defaultCapabilitiesJson?: unknown[];
};

export async function listMcpSources() {
  await ensureDefaultRegistrySource();
  return listRegistrySources();
}

export async function upsertMcpSource(input: {
  id?: string;
  name: string;
  baseUrl: string;
  authType?: "none" | "bearer" | "api_key";
  authRef?: string;
  enabled?: boolean;
  isDefault?: boolean;
  syncIntervalSec?: number;
}) {
  const db = await getDb();
  if (input.id) {
    const rows = await db.select().from(mcpRegistrySource).where(eq(mcpRegistrySource.id, input.id)).limit(1);
    if (rows[0]) {
      await db
        .update(mcpRegistrySource)
        .set({
          name: input.name,
          baseUrl: input.baseUrl,
          authType: input.authType ?? rows[0].authType,
          authRef: input.authRef ?? rows[0].authRef,
          enabled: input.enabled ?? rows[0].enabled,
          isDefault: input.isDefault ?? rows[0].isDefault,
          syncIntervalSec: input.syncIntervalSec ?? rows[0].syncIntervalSec,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(mcpRegistrySource.id, input.id));
      const updated = await db.select().from(mcpRegistrySource).where(eq(mcpRegistrySource.id, input.id)).limit(1);
      return updated[0];
    }
  }

  if (input.isDefault) {
    await db.update(mcpRegistrySource).set({ isDefault: false });
  }
  const id = input.id ?? randomUUID();
  await db.insert(mcpRegistrySource).values({
    id,
    name: input.name,
    baseUrl: input.baseUrl,
    authType: input.authType ?? "none",
    authRef: input.authRef ?? null,
    enabled: input.enabled ?? true,
    isDefault: input.isDefault ?? false,
    syncIntervalSec: input.syncIntervalSec ?? 300,
  });
  const created = await db.select().from(mcpRegistrySource).where(eq(mcpRegistrySource.id, id)).limit(1);
  return created[0];
}

export async function setDefaultSource(id: string) {
  const db = await getDb();
  await db.update(mcpRegistrySource).set({ isDefault: false });
  await db
    .update(mcpRegistrySource)
    .set({ isDefault: true, updatedAt: new Date().toISOString() })
    .where(eq(mcpRegistrySource.id, id));
  const rows = await db.select().from(mcpRegistrySource).where(eq(mcpRegistrySource.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function syncSourceNow(id: string) {
  return syncRegistrySource(id);
}

export async function listCatalogItems(input?: { sourceId?: string; q?: string; risk?: "low" | "medium" | "high" }) {
  const db = await getDb();
  const filters = [];
  if (input?.sourceId) filters.push(eq(mcpCatalogItem.sourceId, input.sourceId));
  if (input?.q) filters.push(like(mcpCatalogItem.name, `%${input.q}%`));
  if (input?.risk) filters.push(eq(mcpCatalogItem.riskLevel, input.risk));
  return db
    .select()
    .from(mcpCatalogItem)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(mcpCatalogItem.updatedAt));
}

function projectScopedServerName(projectId: string, requested: string): string {
  return `${projectId.slice(0, 8)}-${requested}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export async function installCatalogItemToProject(input: {
  projectId: string;
  catalogItemId: string;
  serverName: string;
  installedBy?: string;
  command?: string;
  url?: string;
  toolName?: string;
  timeoutMs?: number;
}): Promise<typeof mcpCatalogInstall.$inferSelect> {
  const db = await getDb();
  const projectRows = await db.select().from(project).where(eq(project.id, input.projectId)).limit(1);
  const projectRow = projectRows[0];
  if (!projectRow) throw new Error("project not found");

  const itemRows = await db.select().from(mcpCatalogItem).where(eq(mcpCatalogItem.id, input.catalogItemId)).limit(1);
  const item = itemRows[0];
  if (!item) throw new Error("catalog item not found");
  const spec = (item.specJson ?? {}) as InstallSpec;
  const legacyCatalogRows = await db.select().from(mcpCatalog).where(eq(mcpCatalog.id, item.id)).limit(1);
  if (!legacyCatalogRows[0]) {
    await db.insert(mcpCatalog).values({
      id: item.id,
      slug: item.slug,
      name: item.name,
      description: item.description,
      provider: item.provider,
      source: "registry",
      riskLevel: item.riskLevel,
      transport: item.transport,
      command: spec.command ?? null,
      url: spec.url ?? null,
      defaultToolName: spec.defaultToolName ?? "",
      defaultTimeoutMs: spec.defaultTimeoutMs ?? 20_000,
      defaultRetryPolicyJson: spec.defaultRetryPolicyJson ?? {},
      defaultRateLimitJson: spec.defaultRateLimitJson ?? {},
      defaultCapabilitiesJson: spec.defaultCapabilitiesJson ?? [],
      setupSchemaJson: spec.setupSchemaJson ?? {},
      enabled: item.enabled,
    });
  }
  const scopedName = projectScopedServerName(input.projectId, input.serverName);

  const serverRows = await db
    .select()
    .from(mcpServerConfig)
    .where(and(eq(mcpServerConfig.projectId, input.projectId), eq(mcpServerConfig.name, scopedName)))
    .limit(1);
  if (serverRows[0]) {
    await db
      .update(mcpServerConfig)
      .set({
        transport: item.transport,
        command: input.command ?? spec.command ?? serverRows[0].command,
        url: input.url ?? spec.url ?? serverRows[0].url,
        capabilitiesJson: spec.defaultCapabilitiesJson ?? serverRows[0].capabilitiesJson,
        enabled: true,
      })
      .where(eq(mcpServerConfig.id, serverRows[0].id));
  } else {
    await db.insert(mcpServerConfig).values({
      id: randomUUID(),
      name: scopedName,
      projectId: input.projectId,
      transport: item.transport,
      command: input.command ?? spec.command ?? null,
      url: input.url ?? spec.url ?? null,
      capabilitiesJson: spec.defaultCapabilitiesJson ?? [],
      enabled: true,
    });
  }

  const toolName = input.toolName?.trim() || spec.defaultToolName || "ping";
  const bindingRows = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.projectId, input.projectId),
        eq(mcpToolBinding.serverName, scopedName),
        eq(mcpToolBinding.toolName, toolName)
      )
    )
    .limit(1);
  if (bindingRows[0]) {
    await db
      .update(mcpToolBinding)
      .set({
        enabled: true,
        timeoutMs: input.timeoutMs ?? spec.defaultTimeoutMs ?? bindingRows[0].timeoutMs,
        retryPolicyJson: spec.defaultRetryPolicyJson ?? bindingRows[0].retryPolicyJson,
        rateLimitJson: spec.defaultRateLimitJson ?? bindingRows[0].rateLimitJson,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mcpToolBinding.id, bindingRows[0].id));
  } else {
    await db.insert(mcpToolBinding).values({
      id: randomUUID(),
      projectId: input.projectId,
      serverName: scopedName,
      toolName,
      enabled: true,
      timeoutMs: input.timeoutMs ?? spec.defaultTimeoutMs ?? 20_000,
      retryPolicyJson: spec.defaultRetryPolicyJson ?? {},
      rateLimitJson: spec.defaultRateLimitJson ?? {},
    });
  }

  const installId = randomUUID();
  await db.insert(mcpCatalogInstall).values({
    id: installId,
    catalogId: item.id,
    catalogItemId: item.id,
    sourceId: item.sourceId,
    workspaceId: projectRow.workspaceId,
    projectId: input.projectId,
    serverName: scopedName,
    status: "installed",
    installStatus: "installed",
    installedBy: input.installedBy ?? "user",
  });
  const rows = await db.select().from(mcpCatalogInstall).where(eq(mcpCatalogInstall.id, installId)).limit(1);
  return rows[0];
}

export async function listProjectInstalls(projectId: string) {
  const db = await getDb();
  return db
    .select()
    .from(mcpCatalogInstall)
    .where(eq(mcpCatalogInstall.projectId, projectId))
    .orderBy(desc(mcpCatalogInstall.createdAt));
}

export async function testProjectInstall(input: {
  installId: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
}) {
  const db = await getDb();
  const rows = await db.select().from(mcpCatalogInstall).where(eq(mcpCatalogInstall.id, input.installId)).limit(1);
  const install = rows[0];
  if (!install) throw new Error("install not found");
  const itemRows = install.catalogItemId
    ? await db.select().from(mcpCatalogItem).where(eq(mcpCatalogItem.id, install.catalogItemId)).limit(1)
    : [];
  const spec = (itemRows[0]?.specJson ?? {}) as InstallSpec;
  const toolName = input.toolName?.trim() || spec.defaultToolName || "ping";
  return dispatchMcpToolCall({
    projectId: install.projectId ?? undefined,
    serverName: install.serverName,
    toolName,
    arguments: input.arguments ?? { ping: true, ts: Date.now() },
  });
}

export async function backfillLegacyCatalogItem(): Promise<void> {
  const db = await getDb();
  const legacy = await db.select().from(mcpCatalog).limit(1);
  if (!legacy[0]) return;
  await ensureDefaultRegistrySource();
}
