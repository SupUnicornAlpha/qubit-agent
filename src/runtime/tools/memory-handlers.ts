import { eq } from "drizzle-orm";
import { NativeMemoryConnector } from "../../connectors/memory/native/native.memory.connector";
import { getDb } from "../../db/sqlite/client";
import { midtermMemory, workflowRun } from "../../db/sqlite/schema";
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
    const workflowId = String(params.workflowId ?? ctx.workflowId ?? "");
    if (!workflowId) throw new Error("memory.summarize_workflow: workflowId is required");

    const db = await getDb();
    const wfRows = await db
      .select({ projectId: workflowRun.projectId, status: workflowRun.status })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowId))
      .limit(1);
    const wf = wfRows[0];
    if (!wf) throw new Error(`memory.summarize_workflow: workflow ${workflowId} not found`);

    if (wf.status === "completed" && wf.projectId) {
      const { getExperienceBus } = await import("../experience");
      getExperienceBus().emit({
        type: "workflow_terminal",
        workflowRunId: workflowId,
        projectId: wf.projectId,
        status: "completed",
      });
    }

    const { consolidateFromWorkflow } = await import("../memory/memory-consolidation");
    return consolidateFromWorkflow(workflowId);
  },
  "memory.consolidate_longterm": async (ctx, params) => {
    const definitionId = String(params.definitionId ?? ctx.definition.id ?? "");
    const projectId = String(params.projectId ?? ctx.projectId ?? "");
    const memoryType = String(params.memoryType ?? "playbook");
    const content = String(params.content ?? "");
    if (!content.trim())
      throw new Error("memory.consolidate_longterm: content is required (LLM-generated summary)");
    if (!projectId) throw new Error("memory.consolidate_longterm: project_id required");

    const now = new Date().toISOString();
    const confidenceScore =
      params.confidenceScore != null ? Number(params.confidenceScore) : null;

    const { getExperienceStore } = await import("../experience");
    const { resolveActiveFsWorkspaceId } = await import("../memory/fs-workspace-id");
    const {
      defaultVisibilityForWriteScope,
      resolveExperienceWriteScope,
    } = await import("../experience/experience-scope");
    const { onExperiencesWritten } = await import("../memory/long-term-memory");

    const fsWorkspaceId = await resolveActiveFsWorkspaceId({
      params,
      workflowId: ctx.workflowId,
    });
    const writeScope = resolveExperienceWriteScope({ projectId, fsWorkspaceId });
    const visibility = defaultVisibilityForWriteScope(writeScope.scope);

    const store = getExperienceStore();
    const exp = await store.insert({
      kind: "semantic",
      subKind: memoryType,
      ...writeScope,
      definitionId: definitionId || null,
      visibility,
      contentJson: {
        summary: content.trim().slice(0, 240),
        body: content.trim(),
        source: "agent_consolidation",
      },
      tagsJson: [`memoryType:${memoryType}`, "source:agent_consolidation", ...(definitionId ? [`def:${definitionId}`] : [])],
      metadataJson: {
        memoryType,
        confidenceScore,
        source: "agent_consolidation",
        legacyParams: params,
      },
      validFrom: now,
      sourceRunId: ctx.workflowId ?? null,
      qualityScore: confidenceScore != null ? Math.max(0, Math.min(1, confidenceScore)) : 0.6,
    });

    await onExperiencesWritten({
      experiences: [exp],
      projectId,
      fsWorkspaceId,
    });

    return {
      experienceId: exp.id,
      memoryType,
      scope: writeScope.scope,
      scopeId: writeScope.scopeId,
      visibility,
    };
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
