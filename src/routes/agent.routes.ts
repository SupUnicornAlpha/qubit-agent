import { and, asc, count, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { Hono } from "hono";
import { reloadBuiltinConnectorsFromSettings } from "../connectors/bootstrap";
import { getDb } from "../db/sqlite/client";
import {
  agentDefinition,
  agentDefinitionDraft,
  agentDefinitionRelease,
  agentGroup,
  agentGroupMember,
  agentProfile,
  longtermMemory,
  mcpCatalog,
  mcpCatalogInstall,
  mcpServerConfig,
  mcpToolBinding,
  midtermMemory,
  sandboxPolicy,
  skillMarketInstall,
} from "../db/sqlite/schema";
import { getRuntimeAgents } from "../runtime/agent-pool";
import { buildToolCatalog } from "../runtime/tools/tool-catalog";
import {
  type PromptMode,
  defaultMemoryNamespace,
  ensureAgentPackLayout,
  getDataDir,
  hashPackContent,
  mergeSystemPrompt,
  readPackFiles,
  writePackMarkdownFiles,
  writePackSessionSnapshotFiles,
} from "../runtime/agent/agent-pack-service";
import {
  loadBuiltinConnectorSettings,
  saveBuiltinConnectorSettings,
} from "../runtime/config/builtin-connector-settings";
import { loadModelConfig, saveModelConfig } from "../runtime/config/model-config";
import { loadWorkspaceRuntimeConfig } from "../runtime/config/workspace-config";
import {
  deleteAgentDefinitionById,
  isBuiltinAgentDefinitionId,
} from "../runtime/agent/delete-agent-definition";
import { buildAgentPromptPreview } from "../runtime/agent/agent-prompt-preview";
import { seedAgentDefinitions } from "../runtime/seed-agent-definitions";
import { graphRunner } from "../runtime/langgraph/graph-factory";
import { dispatchMcpToolCall } from "../runtime/mcp/dispatcher";
import {
  installCatalogItemToProject,
  listCatalogItemsPaginated,
  listMcpSources,
  listProjectInstalls,
  setDefaultSource,
  syncSourceNow,
  testProjectInstall,
  uninstallProjectCatalogInstall,
  upsertMcpSource,
} from "../runtime/mcp/market-service";
import { deriveMcpServerOrigin } from "../runtime/mcp/origin";
import { RESEARCH_TEAM_GROUP_TOPOLOGY_ROLE_SET } from "../runtime/msa/analyst-team";
import {
  DEFAULT_OPEN_SKILL_MARKET_BASE,
  ensureOpenSkillMarketLoaded,
  getOpenSkillMarketCacheSnapshot,
  getOpenSkillMarketEntry,
  loadOpenSkillMarketRegistry,
  searchOpenSkillMarketEntriesPaginated,
} from "../runtime/skills/open-skill-market-registry";
import {
  getSkillsMpCacheSize,
  resolveSkillsMpEntryForInstall,
  searchSkillsMp,
  searchSkillsMpPaginated,
} from "../runtime/skills/skillsmp-client";
import { ALL_AGENT_ROLES, type AgentRole } from "../types/entities";

export const agentRouter = new Hono();

function validateAgentGroupRelationsJson(relations: unknown, memberRoles: string[]): string | null {
  if (!Array.isArray(relations)) return "relationsJson must be an array";
  const roleSet = new Set(memberRoles);

  const asEdgeString = (v: unknown): string | null => {
    if (typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
    return null;
  };

  for (const row of relations) {
    if (row == null) continue;
    if (typeof row !== "object" || Array.isArray(row))
      return "each relation entry must be a plain object";
    const rec = row as Record<string, unknown>;
    if (Object.keys(rec).length === 0) continue;

    if (rec.type === "topology_canvas") {
      const np = rec.nodePositions;
      if (np !== undefined && (typeof np !== "object" || np === null || Array.isArray(np))) {
        return "topology_canvas.nodePositions must be an object";
      }
      if (np && typeof np === "object" && !Array.isArray(np)) {
        for (const [k, v] of Object.entries(np as Record<string, unknown>)) {
          if (!roleSet.has(k))
            return `topology layout key "${k}" is not a member role in this group`;
          if (!v || typeof v !== "object" || Array.isArray(v))
            return "each layout value must be {x,y}";
          const o = v as Record<string, unknown>;
          const x = o.x;
          const y = o.y;
          const xn =
            typeof x === "number" ? x : typeof x === "string" ? Number.parseFloat(x) : Number.NaN;
          const yn =
            typeof y === "number" ? y : typeof y === "string" ? Number.parseFloat(y) : Number.NaN;
          if (!Number.isFinite(xn) || !Number.isFinite(yn))
            return "layout entries need numeric x,y";
        }
      }
      continue;
    }

    if (rec.kind === "broadcast") {
      const from = asEdgeString(rec.from);
      const targets = rec.targets;
      if (from === null) return "broadcast.from must be a string";
      if (!Array.isArray(targets)) return "broadcast.targets must be an array";
      if (!roleSet.has(from)) return `broadcast source "${from}" is not a member of this group`;
      for (const t of targets) {
        const ts = asEdgeString(t);
        if (ts === null) return "broadcast target must be a string";
        if (ts === from) return "broadcast from and target must differ";
        if (!roleSet.has(ts)) return `broadcast target "${ts}" is not a member of this group`;
      }
      continue;
    }

    const from = asEdgeString(rec.from);
    const to = asEdgeString(rec.to);
    if (from === null && to === null) continue;
    if (from === null || to === null) return "relation from/to must be strings";
    if (from === to) return "relation from and to must differ";
    if (!roleSet.has(from) || !roleSet.has(to)) {
      return `relation endpoints must be roles of members in this group (got ${from} → ${to})`;
    }
  }
  return null;
}

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
    const existing = await db
      .select()
      .from(mcpCatalog)
      .where(eq(mcpCatalog.slug, item.slug))
      .limit(1);
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

/** Agent 可配置工具目录（builtin + connector 路由） */
agentRouter.get("/tools/catalog", (c) => {
  return c.json({ ok: true, data: buildToolCatalog() });
});

agentRouter.get("/", (c) => {
  const agents = getRuntimeAgents().map((runtime) => ({
    id: runtime.instanceId,
    definitionId: runtime.definitionId,
    role: runtime.role,
    name: runtime.name,
    version: runtime.version,
    status: runtime.status,
    executionPath: runtime.executionPath,
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

/**
 * 手动「重载系统预设」：把所有内置 Agent 定义 / 编组 强制重置回 SEED。
 * - 正常启动会保留用户改动；这个接口是唯一显式破坏用户改动的入口。
 * - 调用后会自动 graphRunner.reload()，让 runtime 立刻拿到新定义。
 */
agentRouter.post("/builtin/reload", async (c) => {
  const report = await seedAgentDefinitions({ force: true });
  const runtimeReload = await graphRunner.reload();
  return c.json({
    ok: true,
    report,
    runtime: { before: runtimeReload.before, after: runtimeReload.after },
  });
});

agentRouter.get("/definitions", async (c) => {
  const db = await getDb();
  const [definitions, drafts, profiles] = await Promise.all([
    db.select().from(agentDefinition),
    db.select().from(agentDefinitionDraft).orderBy(desc(agentDefinitionDraft.createdAt)),
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

/** 在 DB 中新建一条 Agent 定义（及 profile）；用于 UI「新建」入口。工作区 agents.json 需另行同步或依赖后续 reload。 */
agentRouter.post("/definitions", async (c) => {
  const body = await c.req.json<{
    role?: string;
    name?: string;
    systemPrompt?: string;
    displayName?: string;
  }>();
  const roleRaw = typeof body.role === "string" ? body.role.trim() : "";
  if (!roleRaw || !(ALL_AGENT_ROLES as readonly string[]).includes(roleRaw)) {
    return c.json({ error: "invalid or missing role" }, 400);
  }
  const role = roleRaw as AgentRole;
  const db = await getDb();
  const policies = await db
    .select()
    .from(sandboxPolicy)
    .where(eq(sandboxPolicy.id, "default-policy"))
    .limit(1);
  if (!policies[0]) {
    return c.json({ error: "default sandbox policy missing; run migrations/seed" }, 500);
  }
  const id = crypto.randomUUID();
  const name =
    typeof body.name === "string" && body.name.trim() ? body.name.trim() : `自定义 · ${role}`;
  const systemPrompt =
    typeof body.systemPrompt === "string" && body.systemPrompt.trim()
      ? body.systemPrompt.trim()
      : "在此填写该 Agent 的系统提示与职责。";
  const displayName =
    typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim()
      : name;
  await db.insert(agentDefinition).values({
    id,
    role,
    name,
    version: "1.0.0",
    systemPrompt,
    toolsJson: toJsonValue([]),
    mcpServersJson: toJsonValue([]),
    skillsJson: toJsonValue([]),
    subscriptionsJson: toJsonValue(["TASK_ASSIGN"]),
    llmProvider: "openai:gpt-4o-mini",
    maxIterations: 20,
    sandboxPolicyId: "default-policy",
    enabled: true,
  });
  await db.insert(agentProfile).values({
    id: crypto.randomUUID(),
    definitionId: id,
    displayName,
    soulFileRef: "",
    promptTemplateRef: undefined,
    description: "",
    tagsJson: toJsonValue([]),
    enabled: true,
    configRootUri: "",
    memoryNamespace: "",
    promptMode: "db_primary",
    configContentHash: "",
    configSyncedAt: "",
  });
  await graphRunner.reload();
  const rows = await db.select().from(agentDefinition).where(eq(agentDefinition.id, id)).limit(1);
  const profRows = await db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.definitionId, id))
    .limit(1);
  return c.json(
    {
      data: {
        definition: rows[0],
        profile: profRows[0] ?? null,
        draft: null,
      },
    },
    201
  );
});

agentRouter.delete("/definitions/:id", async (c) => {
  const definitionId = c.req.param("id");
  if (isBuiltinAgentDefinitionId(definitionId)) {
    return c.json({ error: "built-in agent definitions cannot be deleted" }, 403);
  }
  const db = await getDb();
  const result = await deleteAgentDefinitionById(db, definitionId);
  if (!result.deleted) {
    const status = result.reason === "not found" ? 404 : 409;
    return c.json({ error: result.reason ?? "delete failed" }, status);
  }
  await graphRunner.reload();
  return c.json({ ok: true, deletedId: definitionId });
});

agentRouter.post("/definitions/:id/prompt-preview", async (c) => {
  const definitionId = c.req.param("id");
  const body = await c.req.json<{
    systemPrompt?: string;
    promptMode?: PromptMode;
    toolsJson?: unknown;
    mcpServersJson?: unknown;
    skillsJson?: unknown;
    subscriptionsJson?: unknown;
  }>().catch(() => ({}));
  const db = await getDb();
  const preview = await buildAgentPromptPreview(db, {
    definitionId,
    overrides: {
      systemPrompt: body.systemPrompt,
      promptMode: body.promptMode,
      toolsJson: body.toolsJson,
      mcpServersJson: body.mcpServersJson,
      skillsJson: body.skillsJson,
      subscriptionsJson: body.subscriptionsJson,
    },
  });
  if (!preview) return c.json({ error: "Agent definition not found" }, 404);
  return c.json({ ok: true, data: preview });
});

agentRouter.get("/definitions/:id/pack", async (c) => {
  const definitionId = c.req.param("id");
  const db = await getDb();
  const defRows = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!defRows[0]) return c.json({ error: "Agent definition not found" }, 404);
  const profRows = await db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.definitionId, definitionId))
    .limit(1);
  const profile = profRows[0];
  const dataDir = getDataDir();
  const read = await readPackFiles({
    dataDir,
    definitionId,
    configRootUri: profile?.configRootUri ?? "",
    soulFileRef: profile?.soulFileRef ?? "",
    promptTemplateRef: profile?.promptTemplateRef,
  });
  const hash = hashPackContent(
    read.agentText,
    read.soulText,
    read.userText,
    read.memoryText,
    read.promptText
  );
  const maxOut = 256 * 1024;
  return c.json({
    data: {
      definitionId,
      packRoot: read.packRoot,
      agentPath: read.agentPath,
      soulPath: read.soulPath,
      promptPath: read.promptPath,
      userPath: read.userPath,
      memoryPath: read.memoryPath,
      agentExists: read.agentExists,
      soulExists: read.soulExists,
      promptExists: read.promptExists,
      userExists: read.userExists,
      memoryExists: read.memoryExists,
      agentMarkdown: read.agentText.slice(0, maxOut),
      soulMarkdown: read.soulText.slice(0, maxOut),
      promptMarkdown: read.promptText.slice(0, maxOut),
      userMarkdown: read.userText.slice(0, maxOut),
      memoryMarkdown: read.memoryText.slice(0, maxOut),
      contentHash: hash,
      profileHash: profile?.configContentHash ?? "",
      promptMode: (profile?.promptMode as PromptMode | undefined) ?? "db_primary",
      memoryNamespace: profile?.memoryNamespace?.trim()
        ? profile.memoryNamespace
        : defaultMemoryNamespace(definitionId),
    },
  });
});

agentRouter.put("/definitions/:id/pack/files", async (c) => {
  const definitionId = c.req.param("id");
  const body = await c.req.json<{
    agentMarkdown?: string;
    soulMarkdown?: string;
    promptMarkdown?: string;
  }>();
  const db = await getDb();
  const defRows = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!defRows[0]) return c.json({ error: "Agent definition not found" }, 404);
  const profRows = await db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.definitionId, definitionId))
    .limit(1);
  const profile = profRows[0];
  const dataDir = getDataDir();
  try {
    const written = await writePackMarkdownFiles({
      dataDir,
      definitionId,
      configRootUri: profile?.configRootUri ?? "",
      agentMarkdown: body.agentMarkdown,
      soulMarkdown: body.soulMarkdown ?? "",
      promptMarkdown: body.promptMarkdown ?? "",
    });
    const now = new Date().toISOString();
    if (profile) {
      await db
        .update(agentProfile)
        .set({
          configContentHash: written.hash,
          configSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(agentProfile.id, profile.id));
    }
    return c.json({ data: { ...written, hash: written.hash } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 400);
  }
});

/** USER.md / MEMORY.md：可由归纳流程或受控工具更新；不得替代 agent.md 的治理 */
agentRouter.put("/definitions/:id/pack/session-snapshot", async (c) => {
  const definitionId = c.req.param("id");
  const body = await c.req.json<{ userMarkdown?: string; memoryMarkdown?: string }>();
  const db = await getDb();
  const defRows = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!defRows[0]) return c.json({ error: "Agent definition not found" }, 404);
  const profRows = await db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.definitionId, definitionId))
    .limit(1);
  const profile = profRows[0];
  const dataDir = getDataDir();
  try {
    const written = await writePackSessionSnapshotFiles({
      dataDir,
      definitionId,
      configRootUri: profile?.configRootUri ?? "",
      userMarkdown: body.userMarkdown ?? "",
      memoryMarkdown: body.memoryMarkdown ?? "",
    });
    const now = new Date().toISOString();
    if (profile) {
      await db
        .update(agentProfile)
        .set({
          configContentHash: written.hash,
          configSyncedAt: now,
          updatedAt: now,
        })
        .where(eq(agentProfile.id, profile.id));
    }
    return c.json({ data: { ...written, hash: written.hash } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 400);
  }
});

agentRouter.post("/definitions/:id/pack/ensure-layout", async (c) => {
  const definitionId = c.req.param("id");
  const db = await getDb();
  const defRows = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!defRows[0]) return c.json({ error: "Agent definition not found" }, 404);
  const profRows = await db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.definitionId, definitionId))
    .limit(1);
  const profile = profRows[0];
  const dataDir = getDataDir();
  const { packRoot, created } = await ensureAgentPackLayout({
    dataDir,
    definitionId,
    configRootUri: profile?.configRootUri ?? "",
  });
  return c.json({ data: { packRoot, created } });
});

agentRouter.post("/definitions/:id/pack/sync-from-fs", async (c) => {
  const definitionId = c.req.param("id");
  const db = await getDb();
  const defRows = await db
    .select()
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!defRows[0]) return c.json({ error: "Agent definition not found" }, 404);
  const profRows = await db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.definitionId, definitionId))
    .limit(1);
  const profile = profRows[0];
  const mode = (profile?.promptMode as PromptMode | undefined) ?? "db_primary";
  const dataDir = getDataDir();
  const read = await readPackFiles({
    dataDir,
    definitionId,
    configRootUri: profile?.configRootUri ?? "",
    soulFileRef: profile?.soulFileRef ?? "",
    promptTemplateRef: profile?.promptTemplateRef,
  });
  const hash = hashPackContent(
    read.agentText,
    read.soulText,
    read.userText,
    read.memoryText,
    read.promptText
  );
  const merged = mergeSystemPrompt({
    mode,
    dbPrompt: defRows[0].systemPrompt,
    agentText: read.agentText,
    soulText: read.soulText,
    userText: read.userText,
    memoryText: read.memoryText,
    promptText: read.promptText,
  });
  const now = new Date().toISOString();
  if (profile) {
    await db
      .update(agentProfile)
      .set({
        configContentHash: hash,
        configSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(agentProfile.id, profile.id));
  }
  return c.json({
    data: {
      updatedDefinition: false,
      systemPromptPreview: merged.slice(0, 2000),
      contentHash: hash,
    },
  });
});

agentRouter.get("/definitions/:id/memory-stats", async (c) => {
  const definitionId = c.req.param("id");
  const db = await getDb();
  const defOk = await db
    .select({ id: agentDefinition.id })
    .from(agentDefinition)
    .where(eq(agentDefinition.id, definitionId))
    .limit(1);
  if (!defOk[0]) return c.json({ error: "Agent definition not found" }, 404);
  const [mid, long] = await Promise.all([
    db
      .select({ n: count() })
      .from(midtermMemory)
      .where(eq(midtermMemory.definitionId, definitionId)),
    db
      .select({ n: count() })
      .from(longtermMemory)
      .where(eq(longtermMemory.definitionId, definitionId)),
  ]);
  return c.json({
    data: {
      definitionId,
      midtermCount: Number(mid[0]?.n ?? 0),
      longtermCount: Number(long[0]?.n ?? 0),
    },
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
      configRootUri?: string;
      memoryNamespace?: string;
      promptMode?: PromptMode;
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
          configRootUri: body.profile.configRootUri ?? profileRows[0].configRootUri,
          memoryNamespace: body.profile.memoryNamespace ?? profileRows[0].memoryNamespace,
          promptMode: body.profile.promptMode ?? profileRows[0].promptMode,
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
        configRootUri: body.profile.configRootUri ?? "",
        memoryNamespace: body.profile.memoryNamespace ?? "",
        promptMode: body.profile.promptMode ?? "db_primary",
        configContentHash: "",
        configSyncedAt: "",
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

agentRouter.post("/definitions/:id/draft/append-skills", async (c) => {
  const definitionId = c.req.param("id");
  const body = await c.req.json<{ skillNames?: string[] }>();
  const names = Array.isArray(body.skillNames)
    ? body.skillNames
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((s) => s.trim())
    : [];
  if (!names.length) return c.json({ error: "skillNames is required" }, 400);
  const db = await getDb();
  const drafts = await db
    .select()
    .from(agentDefinitionDraft)
    .where(eq(agentDefinitionDraft.definitionId, definitionId))
    .orderBy(desc(agentDefinitionDraft.createdAt))
    .limit(1);
  if (!drafts[0]) return c.json({ error: "no draft for this definition" }, 404);
  const d = drafts[0];
  const raw = d.skillsJson as unknown;
  const cur = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  const next = [...new Set([...cur, ...names])];
  await db
    .update(agentDefinitionDraft)
    .set({ skillsJson: toJsonValue(next) })
    .where(eq(agentDefinitionDraft.id, d.id));
  const latest = await db
    .select()
    .from(agentDefinitionDraft)
    .where(eq(agentDefinitionDraft.id, d.id))
    .limit(1);
  return c.json({ data: latest[0] });
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
  const profRows = await db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.definitionId, definitionId))
    .limit(1);
  const prof = profRows[0];
  const systemPromptToSave = draft.systemPrompt;
  if (prof) {
    const read = await readPackFiles({
      dataDir: getDataDir(),
      definitionId,
      configRootUri: prof.configRootUri ?? "",
      soulFileRef: prof.soulFileRef ?? "",
      promptTemplateRef: prof.promptTemplateRef,
    });
    const now = new Date().toISOString();
    const h = hashPackContent(
      read.agentText,
      read.soulText,
      read.userText,
      read.memoryText,
      read.promptText
    );
    await db
      .update(agentProfile)
      .set({ configContentHash: h, configSyncedAt: now, updatedAt: now })
      .where(eq(agentProfile.id, prof.id));
  }
  await db
    .update(agentDefinition)
    .set({
      version: body.releasedVersion ?? draft.versionTag,
      systemPrompt: systemPromptToSave,
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
    db.select().from(agentDefinition).where(eq(agentDefinition.id, definitionId)).limit(1),
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
      parseError: fileBundle.parseError ?? null,
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

agentRouter.get("/builtin-connector-config", async (c) => {
  const data = await loadBuiltinConnectorSettings();
  return c.json({ data });
});

agentRouter.post("/builtin-connector-config", async (c) => {
  const body = await c.req.json<{
    "qubit-data"?: Record<string, unknown>;
    "qubit-news"?: Record<string, unknown>;
  }>();
  await saveBuiltinConnectorSettings({
    ...(body["qubit-data"] !== undefined ? { "qubit-data": body["qubit-data"] } : {}),
    ...(body["qubit-news"] !== undefined ? { "qubit-news": body["qubit-news"] } : {}),
  });
  const data = await reloadBuiltinConnectorsFromSettings();
  return c.json({ data });
});

agentRouter.get("/mcp/servers", async (c) => {
  const db = await getDb();
  const projectId = c.req.query("projectId");
  const rows = await db
    .select()
    .from(mcpServerConfig)
    .where(
      projectId
        ? or(eq(mcpServerConfig.projectId, projectId), eq(mcpServerConfig.projectId, null))
        : undefined
    )
    .orderBy(desc(mcpServerConfig.createdAt));

  /*
   * 派生 origin（builtin / market / manual）—— 详见 runtime/mcp/origin.ts。
   * 关键点：只把"未移除"的市场安装算作 market 来源；用户卸载后该 server 应回退到
   * "manual"（如果还存在配置）或不再出现，避免徽标永远不变。
   */
  const installRows = projectId
    ? await db
        .select({
          serverName: mcpCatalogInstall.serverName,
          installStatus: mcpCatalogInstall.installStatus,
        })
        .from(mcpCatalogInstall)
        .where(eq(mcpCatalogInstall.projectId, projectId))
    : [];
  const marketNames = new Set<string>();
  for (const r of installRows) {
    if (r.installStatus !== "removed") marketNames.add(r.serverName);
  }

  const data = rows.map((r) => ({
    ...r,
    origin: deriveMcpServerOrigin(
      { name: r.name, projectId: r.projectId ?? null, capabilitiesJson: r.capabilitiesJson },
      marketNames
    ),
  }));
  return c.json({ data });
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
        body.projectId
          ? eq(mcpServerConfig.projectId, body.projectId)
          : eq(mcpServerConfig.projectId, null)
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
  const created = await db
    .select()
    .from(mcpServerConfig)
    .where(eq(mcpServerConfig.id, id))
    .limit(1);
  return c.json({ data: created[0] }, 201);
});

agentRouter.get("/mcp/bindings", async (c) => {
  const db = await getDb();
  const projectId = c.req.query("projectId");
  const definitionId = c.req.query("definitionId");
  const rows = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        projectId
          ? or(eq(mcpToolBinding.projectId, projectId), isNull(mcpToolBinding.projectId))
          : undefined,
        definitionId
          ? or(eq(mcpToolBinding.definitionId, definitionId), isNull(mcpToolBinding.definitionId))
          : undefined
      )
    )
    .orderBy(desc(mcpToolBinding.createdAt));
  return c.json({ data: rows });
});

agentRouter.post("/mcp/bindings/upsert", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    definitionId?: string | null;
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
  const defKey =
    body.definitionId === undefined
      ? isNull(mcpToolBinding.definitionId)
      : body.definitionId
        ? eq(mcpToolBinding.definitionId, body.definitionId)
        : isNull(mcpToolBinding.definitionId);
  const existing = await db
    .select()
    .from(mcpToolBinding)
    .where(
      and(
        eq(mcpToolBinding.serverName, body.serverName),
        eq(mcpToolBinding.toolName, body.toolName),
        body.projectId
          ? eq(mcpToolBinding.projectId, body.projectId)
          : isNull(mcpToolBinding.projectId),
        defKey
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
    const latest = await db
      .select()
      .from(mcpToolBinding)
      .where(eq(mcpToolBinding.id, existing[0].id))
      .limit(1);
    return c.json({ data: latest[0] });
  }
  const id = crypto.randomUUID();
  await db.insert(mcpToolBinding).values({
    id,
    projectId: body.projectId ?? null,
    definitionId: body.definitionId ?? null,
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
    definitionId?: string;
    serverName: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  }>();
  if (!body.serverName || !body.toolName) {
    return c.json({ error: "serverName and toolName are required" }, 400);
  }
  try {
    const data = await dispatchMcpToolCall({
      projectId: body.projectId,
      definitionId: body.definitionId,
      serverName: body.serverName,
      toolName: body.toolName,
      arguments: body.arguments ?? {},
    });
    return c.json({ ok: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isCircuit = message.includes("circuit breaker open");
    const detail = isCircuit
      ? `${message}（同一 server+tool 在短时间内失败次数过多，约 30 秒后会自动恢复；若根因是缺少 uvx，请先修好环境再测。）`
      : message;
    return c.json({ ok: false, error: detail }, 500);
  }
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
  const catalogRows = await db
    .select()
    .from(mcpCatalog)
    .where(eq(mcpCatalog.id, body.catalogId))
    .limit(1);
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
    .where(
      and(
        eq(mcpToolBinding.serverName, serverName),
        eq(mcpToolBinding.toolName, toolName),
        isNull(mcpToolBinding.definitionId)
      )
    )
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
      definitionId: null,
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
  const installed = await db
    .select()
    .from(mcpCatalogInstall)
    .where(eq(mcpCatalogInstall.id, installId))
    .limit(1);
  return c.json({ data: installed[0] }, 201);
});

agentRouter.post("/mcp/catalog/:id/test", async (c) => {
  const catalogId = c.req.param("id");
  const body = await c.req.json<{
    serverName?: string;
    toolName?: string;
    arguments?: Record<string, unknown>;
  }>();
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
  const pageRaw = c.req.query("page");
  const pageSizeRaw = c.req.query("pageSize");
  const page = pageRaw ? Number(pageRaw) : 1;
  const pageSize = pageSizeRaw ? Number(pageSizeRaw) : 24;
  const data = await listCatalogItemsPaginated({
    sourceId: sourceId || undefined,
    q: q || undefined,
    risk,
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : 24,
  });
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

agentRouter.delete("/mcp/market/installs/:id", async (c) => {
  const installId = c.req.param("id");
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "projectId is required" }, 400);
  try {
    const data = await uninstallProjectCatalogInstall({ installId, projectId });
    return c.json({ data });
  } catch (error) {
    const message = (error as Error).message;
    if (message === "install not found") return c.json({ error: message }, 404);
    throw error;
  }
});

agentRouter.post("/mcp/market/installs/:id/test", async (c) => {
  const installId = c.req.param("id");
  const body = await c.req
    .json<{ toolName?: string; arguments?: Record<string, unknown> }>()
    .catch(() => ({}));
  const data = await testProjectInstall({
    installId,
    toolName: body.toolName,
    arguments: body.arguments,
  });
  return c.json({ ok: true, data });
});

agentRouter.get("/skills/market/status", (c) => {
  const open = getOpenSkillMarketCacheSnapshot();
  return c.json({
    data: {
      ...open,
      skillsmpCacheSize: getSkillsMpCacheSize(),
      defaultSkillProvider: "skillsmp" as const,
    },
  });
});

agentRouter.post("/skills/market/refresh", async (c) => {
  const body = await c.req
    .json<{ baseUrl?: string; provider?: string; apiKey?: string }>()
    .catch(() => ({}));
  const provider = (body.provider ?? "skillsmp").toLowerCase();
  try {
    if (provider === "open") {
      const baseUrl =
        typeof body.baseUrl === "string" && body.baseUrl.trim()
          ? body.baseUrl.trim()
          : DEFAULT_OPEN_SKILL_MARKET_BASE;
      await loadOpenSkillMarketRegistry(baseUrl);
    } else {
      const apiKey =
        typeof body.apiKey === "string" && body.apiKey.trim()
          ? body.apiKey.trim()
          : process.env.SKILLSMP_API_KEY;
      await searchSkillsMp("skill", 5, apiKey);
    }
    const open = getOpenSkillMarketCacheSnapshot();
    return c.json({
      data: {
        ...open,
        skillsmpCacheSize: getSkillsMpCacheSize(),
        defaultSkillProvider: "skillsmp" as const,
        lastRefreshProvider: provider === "open" ? ("open" as const) : ("skillsmp" as const),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }
});

agentRouter.get("/skills/market/search", async (c) => {
  const q = c.req.query("q") ?? "";
  const pageRaw = c.req.query("page");
  const pageSizeRaw = c.req.query("pageSize") ?? c.req.query("limit");
  const page = pageRaw ? Number(pageRaw) : 1;
  const pageSize = pageSizeRaw ? Number(pageSizeRaw) : 24;
  const baseUrl = c.req.query("baseUrl");
  const provider = (c.req.query("provider") ?? "skillsmp").toLowerCase();
  const safePage = Number.isFinite(page) ? Math.max(1, page) : 1;
  const safePageSize = Number.isFinite(pageSize) ? pageSize : 24;
  try {
    if (provider === "open") {
      await ensureOpenSkillMarketLoaded(
        typeof baseUrl === "string" && baseUrl.trim()
          ? baseUrl.trim()
          : DEFAULT_OPEN_SKILL_MARKET_BASE
      );
      const data = searchOpenSkillMarketEntriesPaginated(q, safePage, safePageSize);
      return c.json({ data });
    }
    const data = await searchSkillsMpPaginated({
      q,
      page: safePage,
      pageSize: safePageSize,
      apiKey: process.env.SKILLSMP_API_KEY,
    });
    return c.json({ data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }
});

agentRouter.get("/skills/installs", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "projectId is required" }, 400);
  const db = await getDb();
  const rows = await db
    .select()
    .from(skillMarketInstall)
    .where(eq(skillMarketInstall.projectId, projectId))
    .orderBy(desc(skillMarketInstall.createdAt));
  return c.json({ data: rows });
});

agentRouter.post("/skills/installs", async (c) => {
  const body = await c.req.json<{
    projectId?: string;
    externalSkillId?: string;
    registry?: string;
    skillName?: string;
    description?: string;
    repo?: string;
    path?: string;
    localPath?: string;
    tags?: string[];
  }>();
  if (!body.projectId) {
    return c.json({ error: "projectId is required" }, 400);
  }

  const registryInput = (body.registry ?? "").trim().toLowerCase();
  if (registryInput === "manual") {
    const skillName = body.skillName?.trim();
    if (!skillName) return c.json({ error: "skillName is required" }, 400);

    const normalizedManualId = skillName
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const externalSkillId = body.externalSkillId?.trim() || `manual:${normalizedManualId || skillName}`;
    const tags = Array.isArray(body.tags)
      ? body.tags.map((x) => String(x).trim()).filter(Boolean)
      : [];
    const db = await getDb();
    const dup = await db
      .select()
      .from(skillMarketInstall)
      .where(
        and(
          eq(skillMarketInstall.projectId, body.projectId),
          eq(skillMarketInstall.externalSkillId, externalSkillId)
        )
      )
      .limit(1);
    if (dup[0]) return c.json({ data: dup[0] });

    const id = crypto.randomUUID();
    await db.insert(skillMarketInstall).values({
      id,
      projectId: body.projectId,
      registry: "manual",
      externalSkillId,
      skillName,
      description: body.description?.trim() ?? "",
      metaJson: {
        source: "manual",
        ...(body.repo?.trim() ? { repo: body.repo.trim() } : {}),
        ...(body.path?.trim() ? { path: body.path.trim() } : {}),
        ...(body.localPath?.trim() ? { localPath: body.localPath.trim() } : {}),
        ...(tags.length ? { tags } : {}),
      },
      installedBy: "user",
    });
    const created = await db
      .select()
      .from(skillMarketInstall)
      .where(eq(skillMarketInstall.id, id))
      .limit(1);
    // M11.B3: 镜像到 agent_skill，让 reason 节点能召回
    try {
      const { skillService } = await import("../runtime/skills/skill-service");
      await skillService.mirrorFromMarketInstall(id);
    } catch (err) {
      console.warn(
        "[agent.routes] mirror manual skill install failed:",
        err instanceof Error ? err.message : err
      );
    }
    return c.json({ data: created[0] }, 201);
  }

  if (!body.externalSkillId?.trim()) {
    return c.json({ error: "externalSkillId is required" }, 400);
  }
  const extId = body.externalSkillId.trim();
  let skill = getOpenSkillMarketEntry(extId);
  let registry = "open-skill-market";
  if (!skill) {
    skill = await resolveSkillsMpEntryForInstall(extId, process.env.SKILLSMP_API_KEY);
    if (skill) registry = "skillsmp";
  }
  if (!skill) {
    await ensureOpenSkillMarketLoaded();
    skill = getOpenSkillMarketEntry(extId);
    if (skill) registry = "open-skill-market";
  }
  if (!skill) {
    return c.json(
      {
        error:
          "未找到该技能：请先用 SkillsMP 或 Open Skill Market 搜索命中条目，或确认 id 与列表一致（SkillsMP 需网络可达）。",
      },
      404
    );
  }
  const db = await getDb();
  const dup = await db
    .select()
    .from(skillMarketInstall)
    .where(
      and(
        eq(skillMarketInstall.projectId, body.projectId),
        eq(skillMarketInstall.externalSkillId, skill.id)
      )
    )
    .limit(1);
  if (dup[0]) return c.json({ data: dup[0] });
  const id = crypto.randomUUID();
  await db.insert(skillMarketInstall).values({
    id,
    projectId: body.projectId,
    registry,
    externalSkillId: skill.id,
    skillName: skill.name,
    description: skill.description ?? "",
    metaJson: {
      repo: skill.repo,
      path: skill.path,
      commitHash: skill.commitHash,
      categories: skill.categories,
      tags: skill.tags,
      ...(skill.compatibility && typeof skill.compatibility === "object"
        ? (skill.compatibility as Record<string, unknown>)
        : {}),
    },
    installedBy: "user",
  });
  const created = await db
    .select()
    .from(skillMarketInstall)
    .where(eq(skillMarketInstall.id, id))
    .limit(1);
  // M11.B3: 镜像到 agent_skill，统一走 skill 检索
  try {
    const { skillService } = await import("../runtime/skills/skill-service");
    await skillService.mirrorFromMarketInstall(id);
  } catch (err) {
    console.warn(
      "[agent.routes] mirror open-market skill install failed:",
      err instanceof Error ? err.message : err
    );
  }
  return c.json({ data: created[0] }, 201);
});

agentRouter.delete("/skills/installs/:id", async (c) => {
  const id = c.req.param("id");
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "projectId is required" }, 400);
  const db = await getDb();
  await db
    .delete(skillMarketInstall)
    .where(and(eq(skillMarketInstall.id, id), eq(skillMarketInstall.projectId, projectId)));
  return c.json({ ok: true });
});

// ─── M11 自进化：agent_skill / curator / evolution REST 入口 ───────────────────

agentRouter.get("/skills/library", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "projectId is required" }, 400);
  const includeArchived = c.req.query("includeArchived") === "true";
  const stateRaw = c.req.query("state") ?? "";
  const { skillService } = await import("../runtime/skills/skill-service");
  const opts: { includeArchived?: boolean; state?: "active" | "stale" | "archived" | "pending_review" } = {};
  if (includeArchived) opts.includeArchived = true;
  if (["active", "stale", "archived", "pending_review"].includes(stateRaw)) {
    opts.state = stateRaw as "active" | "stale" | "archived" | "pending_review";
  }
  const rows = await skillService.list(projectId, opts);
  return c.json({ count: rows.length, data: rows });
});

agentRouter.get("/skills/library/:id", async (c) => {
  const id = c.req.param("id");
  const { skillService } = await import("../runtime/skills/skill-service");
  const skill = await skillService.findById(id);
  if (!skill) return c.json({ error: "skill not found" }, 404);
  return c.json({ data: skill });
});

agentRouter.patch("/skills/library/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    description?: string;
    bodyMd?: string;
    category?: string;
    pinned?: boolean;
    state?: "active" | "stale" | "archived" | "pending_review";
    metadata?: Record<string, unknown>;
    bumpVersion?: boolean;
  }>();
  const { skillService } = await import("../runtime/skills/skill-service");
  try {
    const patchInput: Parameters<typeof skillService.patch>[0] = { skillId: id };
    if (typeof body.description === "string") patchInput.description = body.description;
    if (typeof body.bodyMd === "string") patchInput.bodyMd = body.bodyMd;
    if (typeof body.category === "string") patchInput.category = body.category;
    if (typeof body.pinned === "boolean") patchInput.pinned = body.pinned;
    if (typeof body.state === "string") patchInput.state = body.state;
    if (body.metadata) patchInput.metadata = body.metadata;
    if (typeof body.bumpVersion === "boolean") patchInput.bumpVersion = body.bumpVersion;
    const updated = await skillService.patch(patchInput);
    return c.json({ data: updated });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

agentRouter.post("/skills/curator/run", async (c) => {
  const body = await c.req.json<{
    projectId: string;
    mode?: "dry_run" | "live";
    useLlm?: boolean;
    triggeredBy?: string;
  }>();
  if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
  const { skillCurator } = await import("../runtime/skills/skill-curator");
  const result = await skillCurator.run({
    projectId: body.projectId,
    mode: body.mode ?? "dry_run",
    ...(body.useLlm !== undefined ? { useLlm: body.useLlm } : {}),
    triggeredBy: body.triggeredBy ?? "api",
  });
  return c.json({ data: result });
});

agentRouter.get("/skills/curator/runs", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "projectId is required" }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const { skillCurator } = await import("../runtime/skills/skill-curator");
  const rows = await skillCurator.listRecentRuns(projectId, limit);
  return c.json({ count: rows.length, data: rows });
});

agentRouter.post("/skills/evolve", async (c) => {
  const body = await c.req.json<{
    projectId: string;
    baseSkillId: string;
    datasetId?: string;
    iterations?: number;
    candidatesPerIteration?: number;
    triggeredBy?: string;
  }>();
  if (!body.projectId || !body.baseSkillId) {
    return c.json({ error: "projectId and baseSkillId are required" }, 400);
  }
  const { skillEvolver } = await import("../runtime/skills/skill-evolve");
  const result = await skillEvolver.evolve({
    projectId: body.projectId,
    baseSkillId: body.baseSkillId,
    ...(body.datasetId ? { datasetId: body.datasetId } : {}),
    ...(body.iterations !== undefined ? { iterations: body.iterations } : {}),
    ...(body.candidatesPerIteration !== undefined ? { candidatesPerIteration: body.candidatesPerIteration } : {}),
    triggeredBy: body.triggeredBy ?? "api",
  });
  return c.json({ data: result });
});

agentRouter.get("/skills/evolve/runs", async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) return c.json({ error: "projectId is required" }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 100);
  const { skillEvolver } = await import("../runtime/skills/skill-evolve");
  const rows = await skillEvolver.listRecentRuns(projectId, limit);
  return c.json({ count: rows.length, data: rows });
});

// ─── Agent groups（分析师等多定义编组）────────────────────────────────────────

agentRouter.get("/agent-groups", async (c) => {
  const db = await getDb();
  const groups = await db.select().from(agentGroup).orderBy(desc(agentGroup.updatedAt));
  const memberCounts = await db
    .select({
      groupId: agentGroupMember.groupId,
      n: count(agentGroupMember.id),
    })
    .from(agentGroupMember)
    .groupBy(agentGroupMember.groupId);
  const countByGroup = new Map(memberCounts.map((row) => [row.groupId, Number(row.n)]));
  return c.json({
    data: groups.map((g) => ({
      ...g,
      memberCount: countByGroup.get(g.id) ?? 0,
    })),
  });
});

agentRouter.post("/agent-groups", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.insert(agentGroup).values({
    id,
    name: body.name.trim(),
    description: (body.description ?? "").trim(),
  });
  const row = await db.select().from(agentGroup).where(eq(agentGroup.id, id)).limit(1);
  return c.json({ data: row[0] }, 201);
});

agentRouter.patch("/agent-groups/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; description?: string; relationsJson?: unknown }>();
  const db = await getDb();
  const existing = await db.select().from(agentGroup).where(eq(agentGroup.id, id)).limit(1);
  if (!existing[0]) return c.json({ error: "not found" }, 404);
  const patch: {
    name?: string;
    description?: string;
    relationsJson?: unknown;
    updatedAt?: string;
  } = {
    updatedAt: new Date().toISOString(),
  };
  if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.description === "string") patch.description = body.description;
  if (body.relationsJson !== undefined) {
    const members = await db
      .select({ role: agentDefinition.role })
      .from(agentGroupMember)
      .innerJoin(agentDefinition, eq(agentGroupMember.definitionId, agentDefinition.id))
      .where(eq(agentGroupMember.groupId, id));
    const memberRoles = members.map((m) => String(m.role));
    const relErr = validateAgentGroupRelationsJson(body.relationsJson, memberRoles);
    if (relErr) return c.json({ error: relErr }, 400);
    patch.relationsJson = toJsonValue(body.relationsJson) as never;
  }
  await db.update(agentGroup).set(patch).where(eq(agentGroup.id, id));
  if (body.relationsJson !== undefined) {
    const { syncOrchestratorTopologyToolsForGroup } = await import(
      "../runtime/orchestration/sync-orchestrator-topology-tools"
    );
    await syncOrchestratorTopologyToolsForGroup(id).catch((err) => {
      console.warn("[agent-groups] sync orchestrator topology tools failed:", err);
    });
  }
  const row = await db.select().from(agentGroup).where(eq(agentGroup.id, id)).limit(1);
  return c.json({ data: row[0] });
});

agentRouter.delete("/agent-groups/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const existing = await db.select().from(agentGroup).where(eq(agentGroup.id, id)).limit(1);
  if (!existing[0]) return c.json({ error: "not found" }, 404);
  await db.delete(agentGroup).where(eq(agentGroup.id, id));
  return c.json({ ok: true });
});

agentRouter.get("/agent-groups/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const g = await db.select().from(agentGroup).where(eq(agentGroup.id, id)).limit(1);
  if (!g[0]) return c.json({ error: "not found" }, 404);
  const members = await db
    .select({
      id: agentGroupMember.id,
      groupId: agentGroupMember.groupId,
      definitionId: agentGroupMember.definitionId,
      sortOrder: agentGroupMember.sortOrder,
      role: agentDefinition.role,
      definitionName: agentDefinition.name,
    })
    .from(agentGroupMember)
    .innerJoin(agentDefinition, eq(agentGroupMember.definitionId, agentDefinition.id))
    .where(eq(agentGroupMember.groupId, id))
    .orderBy(asc(agentGroupMember.sortOrder), asc(agentGroupMember.id));
  return c.json({ data: { group: g[0], members } });
});

agentRouter.post("/agent-groups/:id/members", async (c) => {
  const groupId = c.req.param("id");
  const body = await c.req.json<{ definitionId?: string; sortOrder?: number }>();
  if (!body.definitionId?.trim()) return c.json({ error: "definitionId is required" }, 400);
  const db = await getDb();
  const g = await db.select().from(agentGroup).where(eq(agentGroup.id, groupId)).limit(1);
  if (!g[0]) return c.json({ error: "group not found" }, 404);
  const def = await db
    .select({ id: agentDefinition.id })
    .from(agentDefinition)
    .where(eq(agentDefinition.id, body.definitionId.trim()))
    .limit(1);
  if (!def[0]) return c.json({ error: "definition not found" }, 404);
  const memberId = crypto.randomUUID();
  const sortOrder =
    typeof body.sortOrder === "number" && Number.isFinite(body.sortOrder)
      ? Math.trunc(body.sortOrder)
      : 0;
  try {
    await db.insert(agentGroupMember).values({
      id: memberId,
      groupId,
      definitionId: body.definitionId.trim(),
      sortOrder,
    });
  } catch {
    return c.json({ error: "member already exists for this definition" }, 409);
  }
  await db
    .update(agentGroup)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(agentGroup.id, groupId));
  const row = await db
    .select()
    .from(agentGroupMember)
    .where(eq(agentGroupMember.id, memberId))
    .limit(1);
  return c.json({ data: row[0] }, 201);
});

agentRouter.delete("/agent-groups/:id/members/:memberId", async (c) => {
  const groupId = c.req.param("id");
  const memberId = c.req.param("memberId");
  const db = await getDb();
  const row = await db
    .select()
    .from(agentGroupMember)
    .where(and(eq(agentGroupMember.id, memberId), eq(agentGroupMember.groupId, groupId)))
    .limit(1);
  if (!row[0]) return c.json({ error: "not found" }, 404);
  await db.delete(agentGroupMember).where(eq(agentGroupMember.id, memberId));
  await db
    .update(agentGroup)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(agentGroup.id, groupId));
  return c.json({ ok: true });
});

// ─── Agent 组（研究团队可选）────────────────────────────────────────────────────

async function assertResearchTeamGroupMembers(definitionIds: string[]) {
  const db = await getDb();
  if (definitionIds.length === 0) {
    return { ok: false as const, error: "members must include at least one agent definition" };
  }
  const defs = await db
    .select()
    .from(agentDefinition)
    .where(inArray(agentDefinition.id, definitionIds));
  if (defs.length !== definitionIds.length) {
    return { ok: false as const, error: "one or more definition ids not found" };
  }
  for (const d of defs) {
    if (!RESEARCH_TEAM_GROUP_TOPOLOGY_ROLE_SET.has(d.role as string)) {
      return {
        ok: false as const,
        error: `only research-team / topology roles allowed in group; got ${d.role}`,
      };
    }
  }
  return { ok: true as const, definitions: defs };
}

agentRouter.get("/groups", async (c) => {
  const workspaceId = c.req.query("workspaceId");
  const db = await getDb();
  const rows = workspaceId
    ? await db
        .select()
        .from(agentGroup)
        .where(or(eq(agentGroup.workspaceId, workspaceId), isNull(agentGroup.workspaceId)))
        .orderBy(asc(agentGroup.name))
    : await db.select().from(agentGroup).orderBy(asc(agentGroup.name));

  const groupIds = rows.map((g) => g.id);
  const members =
    groupIds.length > 0
      ? await db
          .select({
            m: agentGroupMember,
            def: agentDefinition,
          })
          .from(agentGroupMember)
          .innerJoin(agentDefinition, eq(agentGroupMember.definitionId, agentDefinition.id))
          .where(inArray(agentGroupMember.groupId, groupIds))
          .orderBy(asc(agentGroupMember.sortOrder))
      : [];

  const byGroup = new Map<string, typeof members>();
  for (const row of members) {
    const gid = row.m.groupId;
    const arr = byGroup.get(gid) ?? [];
    arr.push(row);
    byGroup.set(gid, arr);
  }

  return c.json({
    data: rows.map((g) => ({
      group: g,
      members: (byGroup.get(g.id) ?? []).map((row) => ({
        id: row.m.id,
        groupId: row.m.groupId,
        definitionId: row.m.definitionId,
        sortOrder: row.m.sortOrder,
        role: row.def.role,
        name: row.def.name,
        version: row.def.version,
      })),
    })),
  });
});

agentRouter.get("/groups/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const g = await db.select().from(agentGroup).where(eq(agentGroup.id, id)).limit(1);
  if (!g[0]) return c.json({ error: "group not found" }, 404);
  const members = await db
    .select({
      m: agentGroupMember,
      def: agentDefinition,
    })
    .from(agentGroupMember)
    .innerJoin(agentDefinition, eq(agentGroupMember.definitionId, agentDefinition.id))
    .where(eq(agentGroupMember.groupId, id))
    .orderBy(asc(agentGroupMember.sortOrder));
  return c.json({
    data: {
      group: g[0],
      members: members.map((row) => ({
        id: row.m.id,
        groupId: row.m.groupId,
        definitionId: row.m.definitionId,
        sortOrder: row.m.sortOrder,
        role: row.def.role,
        name: row.def.name,
        version: row.def.version,
        systemPrompt: row.def.systemPrompt,
      })),
    },
  });
});

agentRouter.post("/groups", async (c) => {
  const body = await c.req.json<{
    name: string;
    workspaceId?: string | null;
    description?: string;
    relationsJson?: unknown[];
    members: Array<{ definitionId: string; sortOrder?: number }>;
  }>();
  if (!body.name?.trim()) return c.json({ error: "name is required" }, 400);
  if (!Array.isArray(body.members) || body.members.length === 0) {
    return c.json({ error: "members array is required" }, 400);
  }
  const db = await getDb();
  if (body.workspaceId) {
    const ws = await db.select().from(workspace).where(eq(workspace.id, body.workspaceId)).limit(1);
    if (!ws[0]) return c.json({ error: "workspace not found" }, 404);
  }
  const ordered = [...body.members].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const definitionIds = ordered.map((m) => m.definitionId);
  const check = await assertResearchTeamGroupMembers(definitionIds);
  if (!check.ok) return c.json({ error: check.error }, 400);

  if (body.relationsJson !== undefined) {
    const memberRoles = check.definitions.map((d) => String(d.role));
    const relErr = validateAgentGroupRelationsJson(body.relationsJson, memberRoles);
    if (relErr) return c.json({ error: relErr }, 400);
  }

  const groupId = crypto.randomUUID();
  await db.insert(agentGroup).values({
    id: groupId,
    workspaceId: body.workspaceId ?? null,
    name: body.name.trim(),
    description: body.description ?? "",
    relationsJson: toJsonValue(body.relationsJson ?? []) as never,
  });
  for (let i = 0; i < ordered.length; i++) {
    await db.insert(agentGroupMember).values({
      id: crypto.randomUUID(),
      groupId,
      definitionId: ordered[i].definitionId,
      sortOrder: ordered[i].sortOrder ?? i,
    });
  }
  const created = await db.select().from(agentGroup).where(eq(agentGroup.id, groupId)).limit(1);
  return c.json({ data: created[0] }, 201);
});

agentRouter.patch("/groups/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    workspaceId?: string | null;
    description?: string;
    relationsJson?: unknown[];
    members?: Array<{ definitionId: string; sortOrder?: number }>;
  }>();
  const db = await getDb();
  const existed = await db.select().from(agentGroup).where(eq(agentGroup.id, id)).limit(1);
  if (!existed[0]) return c.json({ error: "group not found" }, 404);
  if (body.workspaceId) {
    const ws = await db.select().from(workspace).where(eq(workspace.id, body.workspaceId)).limit(1);
    if (!ws[0]) return c.json({ error: "workspace not found" }, 404);
  }
  if (body.members) {
    const ordered = [...body.members].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const definitionIds = ordered.map((m) => m.definitionId);
    const check = await assertResearchTeamGroupMembers(definitionIds);
    if (!check.ok) return c.json({ error: check.error }, 400);
    await db.delete(agentGroupMember).where(eq(agentGroupMember.groupId, id));
    for (let i = 0; i < ordered.length; i++) {
      await db.insert(agentGroupMember).values({
        id: crypto.randomUUID(),
        groupId: id,
        definitionId: ordered[i].definitionId,
        sortOrder: ordered[i].sortOrder ?? i,
      });
    }
  }
  if (body.relationsJson !== undefined) {
    const members = await db
      .select({ role: agentDefinition.role })
      .from(agentGroupMember)
      .innerJoin(agentDefinition, eq(agentGroupMember.definitionId, agentDefinition.id))
      .where(eq(agentGroupMember.groupId, id));
    const memberRoles = members.map((m) => String(m.role));
    const relErr = validateAgentGroupRelationsJson(body.relationsJson, memberRoles);
    if (relErr) return c.json({ error: relErr }, 400);
  }
  const now = new Date().toISOString();
  await db
    .update(agentGroup)
    .set({
      name: body.name?.trim() ?? existed[0].name,
      workspaceId: body.workspaceId !== undefined ? body.workspaceId : existed[0].workspaceId,
      description: body.description ?? existed[0].description,
      relationsJson:
        body.relationsJson !== undefined
          ? (toJsonValue(body.relationsJson) as never)
          : existed[0].relationsJson,
      updatedAt: now,
    })
    .where(eq(agentGroup.id, id));
  const updated = await db.select().from(agentGroup).where(eq(agentGroup.id, id)).limit(1);
  return c.json({ data: updated[0] });
});

agentRouter.delete("/groups/:id", async (c) => {
  const id = c.req.param("id");
  const db = await getDb();
  const existed = await db.select().from(agentGroup).where(eq(agentGroup.id, id)).limit(1);
  if (!existed[0]) return c.json({ error: "group not found" }, 404);
  await db.delete(agentGroup).where(eq(agentGroup.id, id));
  return c.json({ ok: true });
});
