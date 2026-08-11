/**
 * FS-first Workspace API（与 DB `/api/v1/workspaces` 并列，互不替换）。
 */
import { Hono, type Context } from "hono";
import {
  createFsWorkspace,
  discoverWorkspaces,
  openWorkspaceById,
  openWorkspaceByRoot,
  resolveProviders,
  listRegisteredProviderKinds,
  buildWorkspaceBootstrapPack,
  WorkspacePathError,
  WorkspaceProviderError,
  writeRunRecord,
} from "../runtime/workspace";

export const fsWorkspaceRouter = new Hono();

function errStatus(e: unknown): number {
  if (e instanceof WorkspacePathError) return 400;
  if (e instanceof WorkspaceProviderError) return 400;
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("not found") || msg.includes("Not a workspace") || msg.includes("Not found")) {
    return 404;
  }
  return 500;
}

function jsonError(c: Context, e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return c.json({ error: message }, errStatus(e) as 400 | 404 | 500);
}

fsWorkspaceRouter.get("/", async (c) => {
  try {
    const hits = await discoverWorkspaces();
    return c.json({
      data: hits.map((h) => ({
        rootPath: h.rootPath,
        manifest: h.manifest,
      })),
    });
  } catch (e) {
    return jsonError(c, e);
  }
});

/** 已注册 Memory / Decision Provider kinds（供 UI / 外部适配探活） */
fsWorkspaceRouter.get("/provider-kinds", async (c) => {
  return c.json({ data: listRegisteredProviderKinds() });
});

fsWorkspaceRouter.post("/", async (c) => {
  try {
    const body = await c.req.json<{
      name: string;
      description?: string;
      slug?: string;
      seedUniverse?: {
        symbols?: Array<{ symbol: string; exchange?: string }>;
        mode?: string;
      };
      defaultFocus?: { symbol: string; exchange?: string };
    }>();
    if (!body?.name?.trim()) {
      return c.json({ error: "name is required" }, 400);
    }
    const created = await createFsWorkspace({
      name: body.name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.seedUniverse !== undefined ? { seedUniverse: body.seedUniverse } : {}),
      ...(body.defaultFocus !== undefined ? { defaultFocus: body.defaultFocus } : {}),
    });
    return c.json(
      {
        data: {
          rootPath: created.rootPath,
          manifest: created.manifest,
        },
      },
      201
    );
  } catch (e) {
    return jsonError(c, e);
  }
});

/** 按本机绝对路径打开（校验为合法 workspace）。 */
fsWorkspaceRouter.post("/open", async (c) => {
  try {
    const body = await c.req.json<{ rootPath: string }>();
    if (!body?.rootPath?.trim()) {
      return c.json({ error: "rootPath is required" }, 400);
    }
    const fs = await openWorkspaceByRoot(body.rootPath.trim());
    const manifest = await fs.readManifest();
    return c.json({ data: { rootPath: fs.rootPath, manifest } });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/manifest", async (c) => {
  try {
    const { fs, manifest } = await openWorkspaceById(c.req.param("id"));
    return c.json({ data: { rootPath: fs.rootPath, manifest } });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/tree", async (c) => {
  try {
    const maxDepth = Number(c.req.query("maxDepth") || 6);
    const includeIndex = c.req.query("includeIndex") === "1";
    const { fs } = await openWorkspaceById(c.req.param("id"));
    const tree = await fs.listTree({ maxDepth, includeIndex });
    return c.json({ data: tree });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/instructions", async (c) => {
  try {
    const { fs } = await openWorkspaceById(c.req.param("id"));
    const { layers } = await fs.loadAgentInstructions();
    return c.json({ data: { layers } });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/bootstrap", async (c) => {
  try {
    const pack = await buildWorkspaceBootstrapPack(c.req.param("id"));
    return c.json({ data: pack });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/file", async (c) => {
  try {
    const relPath = c.req.query("path");
    if (!relPath) return c.json({ error: "path query required" }, 400);
    const { fs } = await openWorkspaceById(c.req.param("id"));
    const content = await fs.readText(relPath);
    return c.json({ data: { path: relPath, content } });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.put("/:id/file", async (c) => {
  try {
    const body = await c.req.json<{ path: string; content: string }>();
    if (!body?.path) return c.json({ error: "path is required" }, 400);
    if (typeof body.content !== "string") {
      return c.json({ error: "content string is required" }, 400);
    }
    const { fs } = await openWorkspaceById(c.req.param("id"));
    await fs.writeText(body.path, body.content);
    return c.json({ data: { path: body.path, ok: true } });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/memory", async (c) => {
  try {
    const workspaceId = c.req.param("id");
    const pinned = c.req.query("pinned");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
    const q = c.req.query("q")?.trim();
    // Default merge Experience (scope=workspace) + FS notes for Workspace panel.
    const include = (c.req.query("include") ?? "merged").toLowerCase();
    if (include === "merged" || include === "all") {
      const { listMergedWorkspaceMemory } = await import(
        "../runtime/memory/long-term-memory"
      );
      const mergeOpts: { q?: string; pinned?: boolean; limit?: number } = {};
      if (q) mergeOpts.q = q;
      if (pinned !== undefined) mergeOpts.pinned = pinned === "1";
      if (limit !== undefined && !Number.isNaN(limit)) mergeOpts.limit = limit;
      const rows = await listMergedWorkspaceMemory(workspaceId, mergeOpts);
      return c.json({ data: rows });
    }
    const { fs, manifest } = await openWorkspaceById(workspaceId);
    const { memory } = resolveProviders(manifest);
    if (q) {
      const searchOpts: { limit?: number } = {};
      if (limit !== undefined && !Number.isNaN(limit)) searchOpts.limit = limit;
      const hits = await memory.search(fs, q, searchOpts);
      return c.json({ data: hits });
    }
    const listOpts: { pinned?: boolean; limit?: number } = {};
    if (pinned !== undefined) listOpts.pinned = pinned === "1";
    if (limit !== undefined && !Number.isNaN(limit)) listOpts.limit = limit;
    const rows = await memory.list(fs, listOpts);
    return c.json({ data: rows });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.post("/:id/memory", async (c) => {
  try {
    const body = await c.req.json<{
      id?: string;
      title: string;
      body: string;
      pinned?: boolean;
      tags?: string[];
      source?: "user" | "agent_proposal" | "import" | "experience";
    }>();
    if (!body?.title?.trim()) return c.json({ error: "title is required" }, 400);
    const { fs, manifest } = await openWorkspaceById(c.req.param("id"));
    const { memory } = resolveProviders(manifest);
    const entry = await memory.upsert(fs, {
      title: body.title,
      body: body.body ?? "",
      ...(body.id !== undefined ? { id: body.id } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.source !== undefined
        ? { source: body.source === "experience" ? "agent_proposal" : body.source }
        : {}),
    });
    return c.json({ data: entry }, 201);
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/memory/bootstrap", async (c) => {
  try {
    const maxChars = c.req.query("maxChars")
      ? Number(c.req.query("maxChars"))
      : undefined;
    const { fs, manifest } = await openWorkspaceById(c.req.param("id"));
    const { memory } = resolveProviders(manifest);
    const text = await memory.loadBootstrap(
      fs,
      maxChars !== undefined ? { maxChars } : {}
    );
    return c.json({ data: { text } });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.delete("/:id/memory/:entryId", async (c) => {
  try {
    const { fs, manifest } = await openWorkspaceById(c.req.param("id"));
    const { memory } = resolveProviders(manifest);
    await memory.remove(fs, c.req.param("entryId"));
    return c.json({ data: { ok: true } });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/memory/:entryId", async (c) => {
  try {
    const { fs, manifest } = await openWorkspaceById(c.req.param("id"));
    const { memory } = resolveProviders(manifest);
    const entry = await memory.get(fs, c.req.param("entryId"));
    if (!entry) return c.json({ error: "Not found" }, 404);
    return c.json({ data: entry });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/decision/strategies", async (c) => {
  try {
    const { fs, manifest } = await openWorkspaceById(c.req.param("id"));
    const { decision } = resolveProviders(manifest);
    const rows = await decision.listStrategies(fs);
    return c.json({
      data: {
        kind: decision.kind,
        items: rows,
      },
    });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.get("/:id/decision/factors", async (c) => {
  try {
    const { fs, manifest } = await openWorkspaceById(c.req.param("id"));
    const { decision } = resolveProviders(manifest);
    const rows = await decision.listFactors(fs);
    return c.json({
      data: {
        kind: decision.kind,
        items: rows,
      },
    });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.post("/:id/decision/sync", async (c) => {
  try {
    const body = await c.req
      .json<{ projectId?: string }>()
      .catch((): { projectId?: string } => ({}));
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) return c.json({ error: "projectId is required" }, 400);
    const { fs, manifest } = await openWorkspaceById(c.req.param("id"));
    const { decision } = resolveProviders(manifest);
    if (!decision.syncIntoWorkspace) {
      return c.json({ error: "decision provider does not support sync" }, 400);
    }
    const result = await decision.syncIntoWorkspace(fs, { projectId });
    return c.json({ data: result });
  } catch (e) {
    return jsonError(c, e);
  }
});

fsWorkspaceRouter.put("/:id/runs/:runId", async (c) => {
  try {
    const body = await c.req.json<{
      title: string;
      status: string;
      workflowId?: string;
      sessionId?: string;
      modelId?: string;
      focus?: { symbol?: string; exchange?: string };
    }>();
    if (!body?.title?.trim()) return c.json({ error: "title is required" }, 400);
    const { fs } = await openWorkspaceById(c.req.param("id"));
    await writeRunRecord(fs, {
      id: c.req.param("runId"),
      title: body.title,
      status: body.status || "queued",
      ...(body.workflowId !== undefined ? { workflowId: body.workflowId } : {}),
      ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
      ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
      ...(body.focus !== undefined ? { focus: body.focus } : {}),
    });
    return c.json({ data: { ok: true } });
  } catch (e) {
    return jsonError(c, e);
  }
});
