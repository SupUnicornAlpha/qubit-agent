import { randomUUID } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
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
const DEFAULT_SOURCE_URL =
  "https://registry.modelcontextprotocol.io/v0.1/servers?version=latest&limit=100";

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

const MAX_REGISTRY_PAGES = 100;

function isCatalogPayload(input: unknown): input is RegistryCatalogPayload {
  if (!input || typeof input !== "object") return false;
  const items = (input as Record<string, unknown>)["items"];
  return Array.isArray(items);
}

interface OfficialServersPage {
  servers: unknown[];
  metadata?: { nextCursor?: string | null };
}

function isOfficialServersPayload(input: unknown): input is OfficialServersPage {
  if (!input || typeof input !== "object") return false;
  const servers = (input as Record<string, unknown>)["servers"];
  return Array.isArray(servers);
}

function ensureServersListUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    if (u.pathname.includes("/v0.1/servers")) {
      if (!u.searchParams.has("version")) u.searchParams.set("version", "latest");
      if (!u.searchParams.has("limit")) u.searchParams.set("limit", "100");
      return u.toString();
    }
  } catch {
    /* keep raw */
  }
  return baseUrl;
}

function mapOfficialServerEntry(entry: unknown): RegistryCatalogPayload["items"][number] | null {
  if (!entry || typeof entry !== "object") return null;
  const wrap = entry as Record<string, unknown>;
  const server = wrap.server;
  if (!server || typeof server !== "object") return null;
  const s = server as Record<string, unknown>;
  const name = typeof s.name === "string" ? s.name : "";
  if (!name) return null;
  const version = typeof s.version === "string" ? s.version : "latest";
  const description = typeof s.description === "string" ? s.description : "";
  const title = typeof s.title === "string" ? s.title : (name.split("/").pop() ?? name);

  const metaBlock = wrap["_meta"];
  if (metaBlock && typeof metaBlock === "object") {
    const official = (metaBlock as Record<string, unknown>)["io.modelcontextprotocol.registry/official"];
    if (official && typeof official === "object") {
      const status = (official as Record<string, unknown>)["status"];
      if (status === "deleted") return null;
    }
  }

  const packages = Array.isArray(s.packages) ? s.packages : [];
  for (const pkg of packages) {
    if (!pkg || typeof pkg !== "object") continue;
    const p = pkg as Record<string, unknown>;
    const transportWrap = p.transport;
    const transportType =
      transportWrap && typeof transportWrap === "object"
        ? (transportWrap as Record<string, unknown>)["type"]
        : undefined;
    if (transportType === "stdio") {
      const identifier = typeof p.identifier === "string" ? p.identifier : "";
      const pkgVer = typeof p.version === "string" ? p.version : version;
      const command = identifier ? `npx -y ${identifier}@${pkgVer}` : undefined;
      const envVars = Array.isArray(p.environmentVariables) ? p.environmentVariables : [];
      const fields = envVars
        .map((ev) => {
          if (!ev || typeof ev !== "object") return null;
          const e = ev as Record<string, unknown>;
          const key = typeof e.name === "string" ? e.name : "";
          if (!key) return null;
          return {
            key,
            type: "string" as const,
            required: e.isRequired === true,
            description: typeof e.description === "string" ? e.description : undefined,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return {
        slug: name,
        name: title,
        version,
        description,
        provider: "registry",
        transport: "stdio",
        riskLevel: "medium",
        externalId: name,
        specJson: {
          command,
          defaultToolName: "",
          setupSchemaJson: fields.length ? { fields } : {},
          defaultRetryPolicyJson: { maxAttempts: 2, backoffMs: 200 },
          defaultRateLimitJson: {},
          defaultCapabilitiesJson: ["tools"],
        },
        enabled: true,
      };
    }
  }

  const remotes = Array.isArray(s.remotes) ? s.remotes : [];
  for (const remote of remotes) {
    if (!remote || typeof remote !== "object") continue;
    const r = remote as Record<string, unknown>;
    const type = r.type;
    const url = typeof r.url === "string" ? r.url : "";
    if ((type === "streamable-http" || type === "sse") && url) {
      return {
        slug: name,
        name: title,
        version,
        description,
        provider: "registry",
        transport: "http",
        riskLevel: "medium",
        externalId: name,
        specJson: {
          url,
          defaultToolName: "",
          setupSchemaJson: {},
          defaultRetryPolicyJson: { maxAttempts: 2, backoffMs: 200 },
          defaultRateLimitJson: {},
          defaultCapabilitiesJson: ["tools"],
        },
        enabled: true,
      };
    }
  }

  return null;
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

  const listUrl = ensureServersListUrl(source.baseUrl);
  const response = await fetch(listUrl, { headers });
  if (!response.ok) {
    throw new Error(`registry source responded ${response.status}`);
  }
  const firstJson = (await response.json()) as unknown;

  if (isCatalogPayload(firstJson)) {
    return firstJson;
  }

  if (!isOfficialServersPayload(firstJson)) {
    throw new Error("invalid registry payload shape");
  }

  const items: RegistryCatalogPayload["items"] = [];
  let cursor: string | null | undefined = firstJson.metadata?.nextCursor ?? null;
  let pageJson: OfficialServersPage = firstJson;

  for (let page = 0; page < MAX_REGISTRY_PAGES; page += 1) {
    for (const entry of pageJson.servers) {
      const mapped = mapOfficialServerEntry(entry);
      if (mapped) items.push(mapped);
    }
    if (!cursor || String(cursor).length === 0) break;

    const nextUrl = new URL(listUrl);
    nextUrl.searchParams.set("cursor", String(cursor));
    const nextRes = await fetch(nextUrl.toString(), { headers });
    if (!nextRes.ok) {
      throw new Error(`registry source responded ${nextRes.status} (page ${page + 2})`);
    }
    const nextJson = (await nextRes.json()) as unknown;
    if (!isOfficialServersPayload(nextJson)) {
      throw new Error("invalid registry payload shape (paged)");
    }
    pageJson = nextJson;
    cursor = nextJson.metadata?.nextCursor ?? null;
  }

  return { items };
}

export async function ensureDefaultRegistrySource(): Promise<void> {
  const db = await getDb();
  const rows = await db.select().from(mcpRegistrySource).limit(1);
  if (!rows[0]) {
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
  await db
    .update(mcpRegistrySource)
    .set({ baseUrl: DEFAULT_SOURCE_URL, updatedAt: new Date().toISOString() })
    .where(like(mcpRegistrySource.baseUrl, "%v1/catalog.json%"));
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
