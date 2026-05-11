import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { mcpCatalogItem, mcpRegistrySource } from "../../db/sqlite/schema";

export interface RegistryCatalogPayload {
  items: Array<{
    externalId?: string;
    slug: string;
    name: string;
    version?: string;
    description?: string;
    provider?: string;
    transport: "stdio" | "http" | "ws";
    riskLevel?: "low" | "medium" | "high";
    specJson?: Record<string, unknown>;
    enabled?: boolean;
  }>;
}

const DEFAULT_SOURCE_NAME = "MCP Official Registry";
const DEFAULT_SOURCE_URL = "https://registry.modelcontextprotocol.io/v1/catalog.json";

const FALLBACK_CATALOG: RegistryCatalogPayload = {
  items: [
    {
      slug: "filesystem-local",
      name: "Filesystem Local",
      version: "1.0.0",
      description: "Filesystem MCP server over stdio.",
      provider: "official",
      transport: "stdio",
      riskLevel: "high",
      specJson: {
        command: "npx -y @modelcontextprotocol/server-filesystem .",
        defaultToolName: "read_file",
        setupSchemaJson: { fields: [{ key: "rootPath", type: "string", required: true }] },
        defaultRetryPolicyJson: { maxAttempts: 2, backoffMs: 200 },
        defaultRateLimitJson: {},
        defaultCapabilitiesJson: ["tools", "resources"],
      },
      enabled: true,
    },
    {
      slug: "fetch-http",
      name: "Fetch HTTP",
      version: "1.0.0",
      description: "HTTP fetch MCP server over stdio.",
      provider: "official",
      transport: "stdio",
      riskLevel: "medium",
      specJson: {
        command: "npx -y @modelcontextprotocol/server-fetch",
        defaultToolName: "fetch",
        setupSchemaJson: {},
        defaultRetryPolicyJson: { maxAttempts: 2, backoffMs: 200 },
        defaultRateLimitJson: {},
        defaultCapabilitiesJson: ["tools"],
      },
      enabled: true,
    },
  ],
};

function isCatalogPayload(input: unknown): input is RegistryCatalogPayload {
  if (!input || typeof input !== "object") return false;
  const items = (input as Record<string, unknown>)["items"];
  return Array.isArray(items);
}

async function fetchCatalogFromSource(
  source: typeof mcpRegistrySource.$inferSelect
): Promise<RegistryCatalogPayload> {
  const headers: Record<string, string> = {};
  if (source.authType === "bearer" && source.authRef) {
    headers["Authorization"] = `Bearer ${source.authRef}`;
  } else if (source.authType === "api_key" && source.authRef) {
    headers["x-api-key"] = source.authRef;
  }
  const response = await fetch(source.baseUrl, { headers });
  if (!response.ok) {
    throw new Error(`registry source responded ${response.status}`);
  }
  const json = (await response.json()) as unknown;
  if (!isCatalogPayload(json)) {
    throw new Error("invalid registry payload shape");
  }
  return json;
}

export async function ensureDefaultRegistrySource(): Promise<void> {
  const db = await getDb();
  const rows = await db.select().from(mcpRegistrySource).limit(1);
  if (rows[0]) return;
  await db.insert(mcpRegistrySource).values({
    id: randomUUID(),
    name: DEFAULT_SOURCE_NAME,
    baseUrl: DEFAULT_SOURCE_URL,
    authType: "none",
    authRef: null,
    enabled: true,
    isDefault: true,
    syncIntervalSec: 300,
  });
}

export async function syncRegistrySource(sourceId: string): Promise<{
  sourceId: string;
  syncedCount: number;
  usedFallback: boolean;
}> {
  const db = await getDb();
  const rows = await db.select().from(mcpRegistrySource).where(eq(mcpRegistrySource.id, sourceId)).limit(1);
  const source = rows[0];
  if (!source) throw new Error("registry source not found");

  let payload: RegistryCatalogPayload;
  let usedFallback = false;
  try {
    payload = await fetchCatalogFromSource(source);
  } catch (error) {
    usedFallback = true;
    payload = FALLBACK_CATALOG;
    await db
      .update(mcpRegistrySource)
      .set({
        lastError: (error as Error).message,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mcpRegistrySource.id, sourceId));
  }

  let syncedCount = 0;
  for (const item of payload.items) {
    const existed = await db
      .select()
      .from(mcpCatalogItem)
      .where(and(eq(mcpCatalogItem.sourceId, sourceId), eq(mcpCatalogItem.slug, item.slug)))
      .limit(1);
    const spec = item.specJson ?? {};
    if (existed[0]) {
      await db
        .update(mcpCatalogItem)
        .set({
          externalId: item.externalId ?? existed[0].externalId,
          name: item.name,
          version: item.version ?? existed[0].version,
          description: item.description ?? "",
          provider: item.provider ?? "community",
          transport: item.transport,
          riskLevel: item.riskLevel ?? "medium",
          specJson: spec,
          enabled: item.enabled ?? true,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(mcpCatalogItem.id, existed[0].id));
    } else {
      await db.insert(mcpCatalogItem).values({
        id: randomUUID(),
        sourceId,
        externalId: item.externalId ?? "",
        slug: item.slug,
        name: item.name,
        version: item.version ?? "latest",
        description: item.description ?? "",
        provider: item.provider ?? "community",
        transport: item.transport,
        riskLevel: item.riskLevel ?? "medium",
        specJson: spec,
        enabled: item.enabled ?? true,
      });
    }
    syncedCount += 1;
  }

  await db
    .update(mcpRegistrySource)
    .set({
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(mcpRegistrySource.id, sourceId));

  return { sourceId, syncedCount, usedFallback };
}

export async function listRegistrySources() {
  const db = await getDb();
  return db.select().from(mcpRegistrySource).orderBy(desc(mcpRegistrySource.createdAt));
}
