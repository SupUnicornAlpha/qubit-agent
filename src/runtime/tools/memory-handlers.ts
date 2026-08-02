import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NativeMemoryConnector } from "../../connectors/memory/native/native.memory.connector";
import { getDb } from "../../db/sqlite/client";
import { longtermMemory, midtermMemory } from "../../db/sqlite/schema";
import type { BuiltinToolHandler } from "./types";

const memoryConnector = new NativeMemoryConnector();

/** Session and midterm-memory access handlers. */
export const MEMORY_HANDLERS: Record<string, BuiltinToolHandler> = {
  write_memory: async (ctx, params) => {
    await memoryConnector.init({});
    const content = String(params.content ?? params.text ?? "");
    if (!content.trim()) throw new Error("write_memory: content is required");
    const record = await memoryConnector.add(content, {
      layer: (params.layer as "session" | "midterm" | "longterm") ?? "midterm",
      asofTime: new Date().toISOString(),
      projectId: String(params.projectId ?? ctx.projectId ?? ""),
      definitionId: ctx.definition.id,
      workflowRunId: ctx.workflowId,
      memoryType: String(params.memoryType ?? "research_note"),
    });
    return { memoryId: record.id };
  },
  search_memory: async (ctx, params) => {
    await memoryConnector.init({});
    const query = String(params.query ?? params.q ?? "");
    const records = await memoryConnector.search(
      query,
      {
        projectId: String(params.projectId ?? ctx.projectId ?? ""),
        definitionId: ctx.definition.id,
      },
      Number(params.topK ?? 8)
    );
    return { query, results: records };
  },
  cleanup_ttl: async (ctx, params) => {
    const db = await getDb();
    const projectId = String(params.projectId ?? ctx.projectId ?? "");
    const cutoff = new Date(Date.now() - Number(params.maxAgeDays ?? 90) * 86400_000).toISOString();
    const rows = projectId
      ? await db.select().from(midtermMemory).where(eq(midtermMemory.projectId, projectId))
      : await db.select().from(midtermMemory).limit(200);
    return {
      scanned: rows.length,
      staleCount: rows.filter((row) => row.timeWindowEnd < cutoff).length,
      note: "TTL 清理预览；物理删除可在后续版本启用",
    };
  },
  "memory.summarize_workflow": async (ctx, params) => {
    const { consolidateFromWorkflow } = await import("../memory/memory-consolidation");
    const workflowId = String(params.workflowId ?? ctx.workflowId ?? "");
    if (!workflowId) throw new Error("memory.summarize_workflow: workflowId is required");
    return consolidateFromWorkflow(workflowId);
  },
  "memory.consolidate_longterm": async (ctx, params) => {
    const db = await getDb();
    const definitionId = String(params.definitionId ?? ctx.definition.id ?? "");
    const projectId = String(params.projectId ?? ctx.projectId ?? "");
    const memoryType = String(params.memoryType ?? "playbook");
    const scope = String(params.scope ?? "project") as "org" | "project" | "strategy";
    const content = String(params.content ?? "");
    if (!content.trim())
      throw new Error("memory.consolidate_longterm: content is required (LLM-generated summary)");
    const now = new Date().toISOString();
    const id = randomUUID();
    await db.insert(longtermMemory).values({
      id,
      scope: scope as never,
      scopeId: scope === "org" ? "default" : projectId || "default",
      definitionId: definitionId || null,
      memoryType: memoryType as never,
      contentJson: { content, ...params, source: "agent_consolidation" },
      embeddingRef: null,
      artifactUri: null,
      validFrom: now,
      validTo: null,
      asofTime: now,
      confidenceScore: params.confidenceScore != null ? Number(params.confidenceScore) : null,
    });
    if (definitionId) {
      const { syncMemoryFromDb } = await import("../memory/memory-workspace-sync");
      await syncMemoryFromDb(definitionId);
    }
    return { longtermMemoryId: id, memoryType, scope };
  },
  "memory.refresh_workspace": async (ctx) => {
    const { syncMemoryFromDb } = await import("../memory/memory-workspace-sync");
    const result = await syncMemoryFromDb(ctx.definition.id);
    if (!result) return { ok: false, error: "definition not found" };
    return {
      ok: true,
      packMemoryPath: result.packMemoryPath,
      workspaceMemoryPath: result.workspaceMemoryPath,
      longtermCount: result.longtermCount,
      midtermCount: result.midtermCount,
    };
  },
};
