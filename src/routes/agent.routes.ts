import { Hono } from "hono";
import { and, desc, eq, or } from "drizzle-orm";
import { getRuntimeAgents } from "../runtime/agent-pool";
import { graphRunner } from "../runtime/langgraph/graph-factory";
import { loadWorkspaceRuntimeConfig } from "../runtime/config/workspace-config";
import { getDb } from "../db/sqlite/client";
import {
  agentDefinition,
  agentDefinitionDraft,
  agentDefinitionRelease,
  agentProfile,
  mcpCatalog,
  mcpCatalogInstall,
  mcpServerConfig,
  mcpToolBinding,
  sandboxPolicy,
} from "../db/sqlite/schema";
import { loadModelConfig, saveModelConfig } from "../runtime/config/model-config";
import { dispatchMcpToolCall } from "../runtime/mcp/dispatcher";
import {
  installCatalogItemToProject,
  listCatalogItems,
  listMcpSources,
  listProjectInstalls,
  setDefaultSource,
  syncSourceNow,
  testProjectInstall,
  upsertMcpSource,
} from "../runtime/mcp/market-service";

export const agentRouter = new Hono();

function toJsonValue(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function buildDiffSummary(params: {
  fileDefinitionIds: string[];
  dbDefinitionIds: string[];
  filePolicyIds: string[];
  dbPolicyIds: string[];
}) {
  const fileDefinitionSet = new Set(params.fileDefinitionIds);
  const dbDefinitionSet = new Set(params.dbDefinitionIds);
  const filePolicySet = new Set(params.filePolicyIds);
  const dbPolicySet = new Set(params.dbPolicyIds);

  const missingDefinitionsInDb = params.fileDefinitionIds.filter((id) => !dbDefinitionSet.has(id));
  const extraDefinitionsInDb = params.dbDefinitionIds.filter((id) => !fileDefinitionSet.has(id));
  const missingPoliciesInDb = params.filePolicyIds.filter((id) => !dbPolicySet.has(id));
  const extraPoliciesInDb = params.dbPolicyIds.filter((id) => !filePolicySet.has(id));

  return {
    isSynced:
      missingDefinitionsInDb.length === 0 &&
      extraDefinitionsInDb.length === 0 &&
      missingPoliciesInDb.length === 0 &&
      extraPoliciesInDb.length === 0,
    counts: {
      fileDefinitions: params.fileDefinitionIds.length,
      dbDefinitions: params.dbDefinitionIds.length,
      filePolicies: params.filePolicyIds.length,
      dbPolicies: params.dbPolicyIds.length,
    },
    missingDefinitionsInDb,
    extraDefinitionsInDb,
    missingPoliciesInDb,
    extraPoliciesInDb,
  };
}

const BUILTIN_MCP_CATALOG: Array<{
  slug: string;
  name: string;
  description: string;
  provider: string;
  source: string;
  riskLevel: "low" | "medium" | "high";
  transport: "stdio" | "http" | "ws";
  command?: string;
  url?: string;
  defaultToolName: string;
  defaultTimeoutMs: number;
  defaultRetryPolicyJson: Record<string, unknown>;
  defaultRateLimitJson: Record<string, unknown>;
  defaultCapabilitiesJson: unknown[];
  setupSchemaJson: Record<string, unknown>;
}> = [
  {
    slug: "filesystem-local",
    name: "Filesystem Local",
    description: "Local filesystem MCP over stdio.",
    provider: "community",
    source: "builtin",
    riskLevel: "high",
    transport: "stdio",
    command: "npx -y @modelcontextprotocol/server-filesystem .",
    defaultToolName: "read_file",
    defaultTimeoutMs: 20_000,
    defaultRetryPolicyJson: { maxAttempts: 2, backoffMs: 200 },
    defaultRateLimitJson: {},
    defaultCapabilitiesJson: ["tools", "resources"],
    setupSchemaJson: { fields: [{ key: "rootPath", type: "string", required: true }] },
  },
  {
    slug: "fetch-http",
    name: "Fetch HTTP",
    description: "Fetch HTTP MCP over stdio.",
    provider: "community",
    source: "builtin",
    riskLevel: "medium",
    transport: "stdio",
    command: "npx -y @modelcontextprotocol/server-fetch",
    defaultToolName: "fetch",
    defaultTimeoutMs: 20_000,
    defaultRetryPolicyJson: { maxAttempts: 2, backoffMs: 200 },
    defaultRateLimitJson: {},
    defaultCapabilitiesJson: ["tools"],
    setupSchemaJson: {},
  },
];

async function ensureBuiltinMcpCatalog(): Promise<void> {
  const db = await getDb();
  for (const item of BUILTIN_MCP_CATALOG) {
    const existing = await db.select().from(mcpCatalog).where(eq(mcpCatalog.slug, item.slug)).limit(1);
    if (existing[0]) continue;
    await db.insert(mcpCatalog).values({
      id: crypto.randomUUID(),
      slug: item.slug,
      name: item.name,
      description: item.description,
      provider: item.provider,
      source: item.source,
      riskLevel: item.riskLevel,
      transport: item.transport,
      command: item.command,
      url: item.url,
      defaultToolName: item.defaultToolName,
      defaultTimeoutMs: item.defaultTimeoutMs,
      defaultRetryPolicyJson: item.defaultRetryPolicyJson,
      defaultRateLimitJson: item.defaultRateLimitJson,
      defaultCapabilitiesJson: item.defaultCapabilitiesJson,
      setupSchemaJson: item.setupSchemaJson,
      enabled: true,
    });
  }
}

agentRouter.get("/", (c) => {
  const agents = getRuntimeAgents().map((runtime) => ({
    id: runtime.instanceId,
    definitionId: runtime.definitionId,
    role: runtime.role,
    version: runtime.version,
    running: runtime.status === "running",
  }));
  return c.json({ data: agents });
});

agentRouter.post("/reload", async (c) => {
  const result = await graphRunner.reload();
  return c.json({
    ok: true,
    before: result.before,
    after: result.after,
  });
});

agentRouter.get("/definitions", async (c) => {
  const db = await getDb();
  const [definitions, drafts, profiles] = await Promise.all([
    db.select().from(agentDefinition),
    db
      .select()
      .from(agentDefinitionDraft)
      .orderBy(desc(agentDefinitionDraft.createdAt)),
    db.select().from(agentProfile),
  ]);
  const latestDraftByDefinition = new Map<string, (typeof drafts)[number]>();
  for (const draft of drafts) {
    if (!latestDraftByDefinition.has(draft.definitionId)) {
      latestDraftByDefinition.set(draft.definitionId, draft);
    }
  }
  const profileByDefinition = new Map(profiles.map((item) => [item.definitionId, item]));
  return c.json({
    data: definitions.map((definition) => ({
      definition,
      profile: profileByDefinition.get(definition.id) ?? null,
      draft: latestDraftByDefinition.get(definition.id) ?? null,
    })),
  });
});

agentRouter.post("/definitions/:id/draft", async (c) => {
  const definitionId = c.req.param("id");
  const body = await c.req.json<{
    systemPrompt?: string;
    toolsJson?: unknown[];
    mcpServersJson?: unknown[];
    skillsJson?: unknown[];
    subscriptionsJson?: unknown[];
    llmProvider?: string;
    maxIterations?: number;
    sandboxPolicyId?: string;
    versionTag?: string;
    changeNote?: string;
    createdBy?: string;
    profile?: {
      displayName?: string;
      soulFileRef?: string;
      promptTemplateRef?: string;
      description?: string;
      tagsJson?: unknown[];
      enabled?: boolean;
    };
  }>();
  const db = await getDb();
  const existed = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!existed[0]) return c.json({ error: "Agent definition not found" }, 404);
  const source = existed[0];
  const draftId = crypto.randomUUID();
  await db.insert(agentDefinitionDraft).values({
    id: draftId,
    definitionId,
    versionTag: body.versionTag ?? `draft-${Date.now()}`,
    systemPrompt: body.systemPrompt ?? source.systemPrompt,
    toolsJson: toJsonValue(body.toolsJson ?? source.toolsJson),
    mcpServersJson: toJsonValue(body.mcpServersJson ?? source.mcpServersJson),
    skillsJson: toJsonValue(body.skillsJson ?? source.skillsJson),
    subscriptionsJson: toJsonValue(body.subscriptionsJson ?? source.subscriptionsJson),
    llmProvider: body.llmProvider ?? source.llmProvider,
    maxIterations: body.maxIterations ?? source.maxIterations,
    sandboxPolicyId: body.sandboxPolicyId ?? source.sandboxPolicyId,
    changeNote: body.changeNote ?? "",
    createdBy: body.createdBy ?? "user",
  });
  if (body.profile) {
    const profileRows = await db
      .select()
      .from(agentProfile)
      .where(eq(agentProfile.definitionId, definitionId))
      .limit(1);
    if (profileRows[0]) {
      await db
        .update(agentProfile)
        .set({
          displayName: body.profile.displayName ?? profileRows[0].displayName,
          soulFileRef: body.profile.soulFileRef ?? profileRows[0].soulFileRef,
          promptTemplateRef: body.profile.promptTemplateRef ?? profileRows[0].promptTemplateRef,
          description: body.profile.description ?? profileRows[0].description,
          tagsJson: toJsonValue(body.profile.tagsJson ?? profileRows[0].tagsJson),
          enabled: body.profile.enabled ?? profileRows[0].enabled,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agentProfile.id, profileRows[0].id));
    } else {
      await db.insert(agentProfile).values({
        id: crypto.randomUUID(),
        definitionId,
        displayName: body.profile.displayName ?? source.name,
        soulFileRef: body.profile.soulFileRef ?? "",
        promptTemplateRef: body.profile.promptTemplateRef,
        description: body.profile.description ?? "",
        tagsJson: toJsonValue(body.profile.tagsJson ?? []),
        enabled: body.profile.enabled ?? source.enabled,
      });
    }
  }
  const created = await db
    .select()
    .from(agentDefinitionDraft)
    .where(eq(agentDefinitionDraft.id, draftId))
    .limit(1);
  return c.json({ data: created[0] }, 201);
});

agentRouter.post("/definitions/:id/release", async (c) => {
  const definitionId = c.req.param("id");
  const body = await c.req.json<{
    draftId: string;
    releasedVersion?: string;
    releaseNote?: string;
    releasedBy?: string;
  }>();
  const db = await getDb();
  const draftRows = await db
    .select()
    .from(agentDefinitionDraft)
    .where(eq(agentDefinitionDraft.id, body.draftId))
    .limit(1);
  if (!draftRows[0] || draftRows[0].definitionId !== definitionId) {
    return c.json({ error: "Draft not found" }, 404);
  }
  const draft = draftRows[0];
  const releaseId = crypto.randomUUID();
  await db
    .update(agentDefinition)
    .set({
      version: body.releasedVersion ?? draft.versionTag,
      systemPrompt: draft.systemPrompt,
      toolsJson: draft.toolsJson,
      mcpServersJson: draft.mcpServersJson,
      skillsJson: draft.skillsJson,
      subscriptionsJson: draft.subscriptionsJson,
      llmProvider: draft.llmProvider,
      maxIterations: draft.maxIterations,
      sandboxPolicyId: draft.sandboxPolicyId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(agentDefinition.id, definitionId));
  await db.insert(agentDefinitionRelease).values({
    id: releaseId,
    definitionId,
    draftId: draft.id,
    releasedVersion: body.releasedVersion ?? draft.versionTag,
    releaseNote: body.releaseNote ?? draft.changeNote,
    releasedBy: body.releasedBy ?? "user",
  });
  const [released, runtimeReload] = await Promise.all([
    db
      .select()
      .from(agentDefinition)
      .where(eq(agentDefinition.id, definitionId))
      .limit(1),
    graphRunner.reload(),
  ]);
  return c.json({
    data: released[0],
    release: { id: releaseId, reloaded: runtimeReload.after },
  });
});

agentRouter.get("/config", async (c) => {
  const [fileBundle, db] = await Promise.all([loadWorkspaceRuntimeConfig(), getDb()]);
  const [definitions, policies] = await Promise.all([
    db.select().from(agentDefinition),
    db.select().from(sandboxPolicy),
  ]);
  const fileDefinitionIds = fileBundle.config?.definitions.map((item) => item.id) ?? [];
  const filePolicyIds = fileBundle.config?.policies.map((item) => item.id) ?? [];
  const diffSummary = buildDiffSummary({
    fileDefinitionIds,
    dbDefinitionIds: definitions.map((item) => item.id),
    filePolicyIds,
    dbPolicyIds: policies.map((item) => item.id),
  });

  return c.json({
    sourceOfTruth: "workspace_files",
    diffSummary,
    workspace: {
      exists: fileBundle.exists,
      configDir: fileBundle.configDir,
      agentsFile: fileBundle.agentsFile,
      sandboxFile: fileBundle.sandboxFile,
      config: fileBundle.config,
    },
    dbEffective: {
      definitions,
      policies,
    },
    runtime: {
      activeAgents: getRuntimeAgents(),
    },
  });
});

agentRouter.get("/model-config", async (c) => {
  const config = (await loadModelConfig()) ?? {
    provider: "mock",
    model: "gpt-4o-mini",
    apiKey: "",
  };
  return c.json({ data: config });
});

agentRouter.post("/model-config", async (c) => {
  const body = await c.req.json<{
    provider?: "openai" | "anthropic" | "ollama" | "deepseek" | "qwen" | "zhipu" | "mock";
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  }>();
  const saved = await saveModelConfig({
    provider: body.provider,
    model: body.model,
    apiKey: body.apiKey,
    baseUrl: body.baseUrl,
  });
  return c.json({ data: saved });
});

agentRouter.get("/mcp/servers", async (c) => {
  const db = await getDb();
  const projectId = c.req.query("projectId");
  const rows = await db
    .select()
    .from(mcpServerConfig)
    .where(
      projectId ? or(eq(mcpServerConfig.projectId, projectId), eq(mcpServerConfig.projectId, null)) : undefined
    )
    .orderBy(desc(mcpServerConfig.createdAt));
  return c.json({ data: rows });
});

agentRouter.post("/mcp/servers/upsert", async (c) => {
  const body = await c.req.json<{
    name?: string;
    projectId?: string;
    transport?: "stdio" | "http" | "ws";
    command?: string;
    url?: string;
    capabilitiesJson?: unknown[];
    enabled?: boolean;
  }>();
  if (!body.name || !body.transport) {
    return c.json({ error: "name and transport are required" }, 400);
  }
  const db = await getDb();
  const existing = await db
    .select()
    .from(mcpServerConfig)
    .where(
      and(
        eq(mcpServerConfig.name, body.name),
        body.projectId ? eq(mcpServerConfig.projectId, body.projectId) : eq(mcpServerConfig.projectId, null)
      )
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(mcpServerConfig)
      .set({
        transport: body.transport,
        command: body.command ?? existing[0].command,
        url: body.url ?? existing[0].url,
        capabilitiesJson: toJsonValue(body.capabilitiesJson ?? existing[0].capabilitiesJson),
        enabled: body.enabled ?? existing[0].enabled,
      })
      .where(eq(mcpServerConfig.id, existing[0].id));
    const updated = await db
      .select()
      .from(mcpServerConfig)
      .where(eq(mcpServerConfig.id, existing[0].id))
      .limit(1);
    return c.json({ data: updated[0] });
  }
  const id = crypto.randomUUID();
  await db.insert(mcpServerConfig).values({
    id,
    name: body.name,
    projectId: body.projectId ?? null,
    transport: body.transport,
    command: body.command ?? null,
    url: body.url ?? null,
    capabilitiesJson: toJsonValue(body.capabilitiesJson ?? []),
    enabled: body.enabled ?? true,
  });
  const created = await db.select().from(mcpServerConfig).where(eq(mcpServerConfig.id, id)).limit(1);
  return c.json({ data: created[0] }, 201);
});

agentRouter.get("/mcp/bindings", async (c) => {
  const db = await getDb();
  const projectId = c.req.query("projectId");
  const rows = await db
    .select()
    .from(mcpToolBinding)
    .where(
      projectId ? or(eq(mcpToolBinding.projectId, projectId), eq(mcpToolBinding.projectId, null)) : undefined
    )
    .orderBy(desc(mcpToolBinding.createdAt));
  return c.json({ data: rows });
});

agentRouter.post("/mcp/bindings/upsert", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    serverName: string;
    toolName: string;
    enabled?: boolean;
    timeoutMs?: number;
    retryPolicyJson?: Record<string, unknown>;
    rateLimitJson?: Record<string, unknown>;
  }>();
  if (!body.serverName || !body.toolName) {
    return c.json({ error: "serverName and toolName are required" }, 400);
  }
  const db = await getDb();
  const existing = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, body.serverName),
        eq(mcpToolBinding.toolName, body.toolName),
        body.projectId ? eq(mcpToolBinding.projectId, body.projectId) : eq(mcpToolBinding.projectId, null)
      )
    )
    .limit(1);
  if (existing[0]) {
    await db
      .update(mcpToolBinding)
      .set({
        enabled: body.enabled ?? existing[0].enabled,
        timeoutMs: body.timeoutMs ?? existing[0].timeoutMs,
        retryPolicyJson: body.retryPolicyJson ?? existing[0].retryPolicyJson,
        rateLimitJson: body.rateLimitJson ?? existing[0].rateLimitJson,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mcpToolBinding.id, existing[0].id));
    const latest = await db.select().from(mcpToolBinding).where(eq(mcpToolBinding.id, existing[0].id)).limit(1);
    return c.json({ data: latest[0] });
  }
  const id = crypto.randomUUID();
  await db.insert(mcpToolBinding).values({
    id,
    projectId: body.projectId ?? null,
    serverName: body.serverName,
    toolName: body.toolName,
    enabled: body.enabled ?? true,
    timeoutMs: body.timeoutMs,
    retryPolicyJson: body.retryPolicyJson ?? {},
    rateLimitJson: body.rateLimitJson ?? {},
  });
  const created = await db.select().from(mcpToolBinding).where(eq(mcpToolBinding.id, id)).limit(1);
  return c.json({ data: created[0] }, 201);
});

agentRouter.post("/mcp/test", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    serverName: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  }>();
  if (!body.serverName || !body.toolName) {
    return c.json({ error: "serverName and toolName are required" }, 400);
  }
  const data = await dispatchMcpToolCall({
    projectId: body.projectId,
    serverName: body.serverName,
    toolName: body.toolName,
    arguments: body.arguments ?? {},
  });
  return c.json({ ok: true, data });
});

agentRouter.get("/mcp/catalog", async (c) => {
  await ensureBuiltinMcpCatalog();
  const db = await getDb();
  const rows = await db.select().from(mcpCatalog).orderBy(desc(mcpCatalog.updatedAt));
  return c.json({ data: rows });
});

agentRouter.post("/mcp/catalog/install", async (c) => {
  const body = await c.req.json<{
    catalogId?: string;
    serverName?: string;
    command?: string;
    url?: string;
    toolName?: string;
    timeoutMs?: number;
    installedBy?: string;
  }>();
  if (!body.catalogId || !body.serverName) {
    return c.json({ error: "catalogId and serverName are required" }, 400);
  }
  const db = await getDb();
  const catalogRows = await db.select().from(mcpCatalog).where(eq(mcpCatalog.id, body.catalogId)).limit(1);
  if (!catalogRows[0]) return c.json({ error: "catalog not found" }, 404);
  const catalog = catalogRows[0];
  const serverName = body.serverName.trim();
  const existingServer = await db
    .select()
    .from(mcpServerConfig)
    .where(eq(mcpServerConfig.name, serverName))
    .limit(1);
  if (existingServer[0]) {
    await db
      .update(mcpServerConfig)
      .set({
        transport: catalog.transport,
        command: body.command ?? catalog.command,
        url: body.url ?? catalog.url,
        capabilitiesJson: catalog.defaultCapabilitiesJson,
        enabled: true,
      })
      .where(eq(mcpServerConfig.id, existingServer[0].id));
  } else {
    await db.insert(mcpServerConfig).values({
      id: crypto.randomUUID(),
      name: serverName,
      transport: catalog.transport,
      command: body.command ?? catalog.command,
      url: body.url ?? catalog.url,
      capabilitiesJson: catalog.defaultCapabilitiesJson,
      enabled: true,
    });
  }

  const toolName = body.toolName?.trim() || catalog.defaultToolName || "ping";
  const bindingRows = await db
    .select()
    .from(mcpToolBinding)
    .where(and(eq(mcpToolBinding.serverName, serverName), eq(mcpToolBinding.toolName, toolName)))
    .limit(1);
  if (bindingRows[0]) {
    await db
      .update(mcpToolBinding)
      .set({
        enabled: true,
        timeoutMs: body.timeoutMs ?? catalog.defaultTimeoutMs,
        retryPolicyJson: catalog.defaultRetryPolicyJson,
        rateLimitJson: catalog.defaultRateLimitJson,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(mcpToolBinding.id, bindingRows[0].id));
  } else {
    await db.insert(mcpToolBinding).values({
      id: crypto.randomUUID(),
      serverName,
      toolName,
      enabled: true,
      timeoutMs: body.timeoutMs ?? catalog.defaultTimeoutMs,
      retryPolicyJson: catalog.defaultRetryPolicyJson,
      rateLimitJson: catalog.defaultRateLimitJson,
    });
  }

  const installId = crypto.randomUUID();
  await db.insert(mcpCatalogInstall).values({
    id: installId,
    catalogId: catalog.id,
    serverName,
    status: "installed",
    installedBy: body.installedBy ?? "user",
  });
  const installed = await db.select().from(mcpCatalogInstall).where(eq(mcpCatalogInstall.id, installId)).limit(1);
  return c.json({ data: installed[0] }, 201);
});

agentRouter.post("/mcp/catalog/:id/test", async (c) => {
  const catalogId = c.req.param("id");
  const body = await c.req.json<{ serverName?: string; toolName?: string; arguments?: Record<string, unknown> }>();
  if (!body.serverName) return c.json({ error: "serverName is required" }, 400);
  const db = await getDb();
  const row = await db.select().from(mcpCatalog).where(eq(mcpCatalog.id, catalogId)).limit(1);
  if (!row[0]) return c.json({ error: "catalog not found" }, 404);
  const toolName = body.toolName?.trim() || row[0].defaultToolName || "ping";
  const data = await dispatchMcpToolCall({
    serverName: body.serverName,
    toolName,
    arguments: body.arguments ?? { ping: true, ts: Date.now() },
  });
  return c.json({ ok: true, data });
});

agentRouter.get("/mcp/sources", async (c) => {
  const rows = await listMcpSources();
  return c.json({ data: rows });
});

agentRouter.post("/mcp/sources", async (c) => {
  const body = await c.req.json<{
    id?: string;
    name?: string;
    baseUrl?: string;
    authType?: "none" | "bearer" | "api_key";
    authRef?: string;
    enabled?: boolean;
    isDefault?: boolean;
    syncIntervalSec?: number;
  }>();
  if (!body.name || !body.baseUrl) return c.json({ error: "name and baseUrl are required" }, 400);
  const data = await upsertMcpSource({
    id: body.id,
    name: body.name,
    baseUrl: body.baseUrl,
    authType: body.authType,
    authRef: body.authRef,
    enabled: body.enabled,
    isDefault: body.isDefault,
    syncIntervalSec: body.syncIntervalSec,
  });
  return c.json({ data }, 201);
});

agentRouter.patch("/mcp/sources/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    baseUrl?: string;
    authType?: "none" | "bearer" | "api_key";
    authRef?: string;
    enabled?: boolean;
    isDefault?: boolean;
    syncIntervalSec?: number;
  }>();
  if (!body.name || !body.baseUrl) return c.json({ error: "name and baseUrl are required" }, 400);
  const data = await upsertMcpSource({
    id,
    name: body.name,
    baseUrl: body.baseUrl,
    authType: body.authType,
    authRef: body.authRef,
    enabled: body.enabled,
    isDefault: body.isDefault,
    syncIntervalSec: body.syncIntervalSec,
  });
  if (body.isDefault) await setDefaultSource(id);
  return c.json({ data });
});

agentRouter.post("/mcp/sources/:id/sync", async (c) => {
  const id = c.req.param("id");
  const data = await syncSourceNow(id);
  return c.json({ ok: true, data });
});

agentRouter.get("/mcp/market/catalog", async (c) => {
  const sourceId = c.req.query("sourceId");
  const q = c.req.query("q");
  const risk = c.req.query("risk") as "low" | "medium" | "high" | undefined;
  const data = await listCatalogItems({ sourceId: sourceId || undefined, q: q || undefined, risk });
  return c.json({ data });
});

agentRouter.post("/mcp/market/install", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    catalogItemId?: string;
    serverName?: string;
    installedBy?: string;
    command?: string;
    url?: string;
    toolName?: string;
    timeoutMs?: number;
  }>();
  if (!body.projectId || !body.catalogItemId || !body.serverName) {
    return c.json({ error: "projectId/catalogItemId/serverName are required" }, 400);
  }
  const data = await installCatalogItemToProject({
    projectId: body.projectId,
    catalogItemId: body.catalogItemId,
    serverName: body.serverName,
    installedBy: body.installedBy,
    command: body.command,
    url: body.url,
    toolName: body.toolName,
    timeoutMs: body.timeoutMs,
  });
  return c.json({ data }, 201);
});

agentRouter.get("/mcp/market/installs", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "projectId is required" }, 400);
  const data = await listProjectInstalls(projectId);
  return c.json({ data });
});

agentRouter.post("/mcp/market/installs/:id/test", async (c) => {
  const installId = c.req.param("id");
  const body = await c.req.json<{ toolName?: string; arguments?: Record<string, unknown> }>().catch(() => ({}));
  const data = await testProjectInstall({
    installId,
    toolName: body.toolName,
    arguments: body.arguments,
  });
  return c.json({ ok: true, data });
});
