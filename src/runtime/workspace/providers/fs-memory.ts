/**
 * builtin.fs_memory — 读写 memory/entries + 维护 MEMORY.md 摘要。
 */
import type { MemoryEntry } from "./types";
import type { WorkspaceFs } from "./workspace-fs";

export const BUILTIN_FS_MEMORY_KIND = "builtin.fs_memory";

export type MemoryProvider = {
  readonly kind: string;
  list(
    ws: WorkspaceFs,
    q?: { pinned?: boolean; limit?: number }
  ): Promise<MemoryEntry[]>;
  get(ws: WorkspaceFs, id: string): Promise<MemoryEntry | null>;
  upsert(
    ws: WorkspaceFs,
    entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt"> & { id?: string }
  ): Promise<MemoryEntry>;
  remove(ws: WorkspaceFs, id: string): Promise<void>;
  search(
    ws: WorkspaceFs,
    query: string,
    opts?: { limit?: number }
  ): Promise<Array<MemoryEntry & { score?: number }>>;
  loadBootstrap(ws: WorkspaceFs, opts?: { maxChars?: number }): Promise<string>;
};

function entryRel(id: string): string {
  return `memory/entries/${id}.json`;
}

async function listAll(ws: WorkspaceFs): Promise<MemoryEntry[]> {
  const tree = await ws.listTree({ maxDepth: 4, includeIndex: false });
  const entriesFolder = tree.children
    ?.find((c) => c.name === "memory")
    ?.children?.find((c) => c.name === "entries");
  const files = entriesFolder?.children?.filter((c) => c.kind !== "folder") ?? [];
  const out: MemoryEntry[] = [];
  for (const f of files) {
    if (!f.relPath?.endsWith(".json")) continue;
    try {
      const e = await ws.readJson<MemoryEntry>(f.relPath);
      if (e?.id) out.push({ ...e, relPath: f.relPath });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return out;
}

async function rewriteMemoryIndex(ws: WorkspaceFs, entries: MemoryEntry[]): Promise<void> {
  const pinned = entries.filter((e) => e.pinned).slice(0, 20);
  const recent = entries.filter((e) => !e.pinned).slice(0, 30);
  const lines = [
    "# Workspace Memory Index",
    "",
    "> 由 builtin.fs_memory 维护摘要；条目正文见 `entries/`。",
    "",
    "## 置顶",
    "",
    ...pinned.map((e) => `- [${e.title}](entries/${e.id}.json)`),
    "",
    "## 最近",
    "",
    ...recent.map((e) => `- [${e.title}](entries/${e.id}.json)`),
    "",
  ];
  await ws.writeText("memory/MEMORY.md", lines.join("\n"));
}

export function createBuiltinFsMemoryProvider(): MemoryProvider {
  return {
    kind: BUILTIN_FS_MEMORY_KIND,

    async list(ws, q) {
      let rows = await listAll(ws);
      if (q?.pinned != null) rows = rows.filter((r) => Boolean(r.pinned) === q.pinned);
      if (q?.limit && q.limit > 0) rows = rows.slice(0, q.limit);
      return rows;
    },

    async get(ws, id) {
      const rel = entryRel(id);
      if (!(await ws.exists(rel))) return null;
      try {
        const e = await ws.readJson<MemoryEntry>(rel);
        return { ...e, relPath: rel };
      } catch {
        return null;
      }
    },

    async upsert(ws, entry) {
      const now = new Date().toISOString();
      const id = entry.id?.trim() || crypto.randomUUID();
      const rel = entryRel(id);
      let createdAt = now;
      if (await ws.exists(rel)) {
        try {
          const prev = await ws.readJson<MemoryEntry>(rel);
          if (prev.createdAt) createdAt = prev.createdAt;
        } catch {
          /* ignore */
        }
      }
      const next: MemoryEntry = {
        id,
        title: entry.title.trim() || id,
        body: entry.body,
        createdAt,
        updatedAt: now,
        pinned: entry.pinned,
        tags: entry.tags,
        source: entry.source ?? "user",
        relPath: rel,
      };
      await ws.writeJson(rel, next);
      const all = await listAll(ws);
      await rewriteMemoryIndex(ws, all);
      return next;
    },

    async remove(ws, id) {
      const rel = entryRel(id);
      if (await ws.exists(rel)) await ws.remove(rel);
      const all = await listAll(ws);
      await rewriteMemoryIndex(ws, all);
    },

    async search(ws, query, opts) {
      const q = query.trim().toLowerCase();
      const limit = opts?.limit ?? 20;
      if (!q) return (await listAll(ws)).slice(0, limit).map((e) => ({ ...e, score: 0 }));
      const scored: Array<MemoryEntry & { score: number }> = [];
      for (const e of await listAll(ws)) {
        const hay = `${e.title}\n${e.body}\n${(e.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) continue;
        let score = 0;
        if (e.title.toLowerCase().includes(q)) score += 3;
        if ((e.tags ?? []).some((t) => t.toLowerCase().includes(q))) score += 2;
        if (e.body.toLowerCase().includes(q)) score += 1;
        if (e.pinned) score += 0.5;
        scored.push({ ...e, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },

    async loadBootstrap(ws, opts) {
      const maxChars = opts?.maxChars ?? 4000;
      if (await ws.exists("memory/MEMORY.md")) {
        const text = await ws.readText("memory/MEMORY.md");
        return text.slice(0, maxChars);
      }
      const recent = await listAll(ws);
      const summary = recent
        .slice(0, 10)
        .map((e) => `- ${e.pinned ? "[pinned] " : ""}${e.title}`)
        .join("\n");
      return summary.slice(0, maxChars);
    },
  };
}
