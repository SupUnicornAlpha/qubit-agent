/**
 * external.http_memory — 可跑的外部记忆 HTTP 适配样例。
 *
 * ProviderRef.config：
 * ```json
 * {
 *   "baseUrl": "https://memory.example.com/v1",
 *   "apiKey": "optional",
 *   "timeoutMs": 8000,
 *   "headers": { "X-Tenant": "demo" }
 * }
 * ```
 *
 * 约定 REST（JSON）：
 * - GET    /entries?pinned=&limit=
 * - GET    /entries/:id
 * - PUT    /entries/:id          body = MemoryEntry（可无 id，用 path）
 * - DELETE /entries/:id
 * - GET    /search?q=&limit=
 * - GET    /bootstrap?maxChars=  → `{ "text": "..." }` 或纯文本
 *
 * 未配置 baseUrl 时明确失败（fail-closed）。
 */
import type { MemoryEntry, ProviderRef } from "../types";
import type { WorkspaceFs } from "../workspace-fs";
import type { MemoryProvider } from "./fs-memory";
import { type HttpProviderConfig, httpJson, readHttpProviderConfig } from "./http-client";

export const EXTERNAL_HTTP_MEMORY_KIND = "external.http_memory";

function requireConfig(ref: ProviderRef): HttpProviderConfig {
  const cfg = readHttpProviderConfig(ref);
  if (!cfg) {
    throw new Error(
      `${EXTERNAL_HTTP_MEMORY_KIND} requires providers.memory.config.baseUrl ` +
        "(or set in .qubit/providers/memory.json). Example: " +
        `{ "kind": "external.http_memory", "config": { "baseUrl": "http://127.0.0.1:8099" } }`
    );
  }
  return cfg;
}

function asEntry(raw: unknown): MemoryEntry {
  const e = raw as Partial<MemoryEntry>;
  if (!e || typeof e !== "object" || !e.id) {
    throw new Error(`${EXTERNAL_HTTP_MEMORY_KIND}: invalid memory entry payload`);
  }
  return {
    id: String(e.id),
    title: String(e.title ?? e.id),
    body: String(e.body ?? ""),
    createdAt: String(e.createdAt ?? new Date().toISOString()),
    updatedAt: String(e.updatedAt ?? new Date().toISOString()),
    pinned: e.pinned,
    tags: e.tags,
    source: e.source,
    relPath: e.relPath,
  };
}

/** @deprecated 使用 createExternalHttpMemoryProvider；保留别名以免旧调用断裂 */
export function createExternalHttpMemoryStub(ref?: ProviderRef): MemoryProvider {
  return createExternalHttpMemoryProvider(ref ?? { kind: EXTERNAL_HTTP_MEMORY_KIND });
}

export function createExternalHttpMemoryProvider(ref: ProviderRef): MemoryProvider {
  const cfg = () => requireConfig(ref);

  return {
    kind: EXTERNAL_HTTP_MEMORY_KIND,

    async list(_ws: WorkspaceFs, q) {
      const c = cfg();
      const params = new URLSearchParams();
      if (q?.pinned != null) params.set("pinned", q.pinned ? "1" : "0");
      if (q?.limit != null) params.set("limit", String(q.limit));
      const qs = params.toString();
      const data = await httpJson<unknown>(c, `/entries${qs ? `?${qs}` : ""}`);
      const rows = Array.isArray(data)
        ? data
        : Array.isArray((data as { entries?: unknown[] })?.entries)
          ? (data as { entries: unknown[] }).entries
          : [];
      return rows.map(asEntry);
    },

    async get(_ws, id) {
      const c = cfg();
      try {
        const data = await httpJson<unknown>(c, `/entries/${encodeURIComponent(id)}`);
        return asEntry(data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/\b404\b/.test(msg)) return null;
        throw e;
      }
    },

    async upsert(_ws, entry) {
      const c = cfg();
      const id = entry.id?.trim() || crypto.randomUUID();
      const now = new Date().toISOString();
      const payload: MemoryEntry = {
        id,
        title: entry.title.trim() || id,
        body: entry.body,
        createdAt: now,
        updatedAt: now,
        pinned: entry.pinned,
        tags: entry.tags,
        source: entry.source ?? "user",
      };
      const data = await httpJson<unknown>(c, `/entries/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: payload,
      });
      return asEntry(data);
    },

    async remove(_ws, id) {
      const c = cfg();
      await httpJson<unknown>(c, `/entries/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    async search(_ws, query, opts) {
      const c = cfg();
      const params = new URLSearchParams({ q: query });
      if (opts?.limit != null) params.set("limit", String(opts.limit));
      const data = await httpJson<unknown>(c, `/search?${params}`);
      const rows = Array.isArray(data)
        ? data
        : Array.isArray((data as { results?: unknown[] })?.results)
          ? (data as { results: unknown[] }).results
          : [];
      return rows.map((raw) => {
        const e = asEntry(raw);
        const score =
          typeof (raw as { score?: unknown }).score === "number"
            ? (raw as { score: number }).score
            : undefined;
        return { ...e, score };
      });
    },

    async loadBootstrap(_ws, opts) {
      const c = cfg();
      const maxChars = opts?.maxChars ?? 4000;
      const data = await httpJson<unknown>(c, `/bootstrap?maxChars=${maxChars}`);
      if (typeof data === "string") return data.slice(0, maxChars);
      if (
        data &&
        typeof data === "object" &&
        typeof (data as { text?: unknown }).text === "string"
      ) {
        return String((data as { text: string }).text).slice(0, maxChars);
      }
      return JSON.stringify(data).slice(0, maxChars);
    },
  };
}
