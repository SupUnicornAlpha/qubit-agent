/**
 * Prime Bridge memory tools — dual recall (Experience + FS) and workspace FS search.
 *
 * Bridged via `/api/v1/prime-bridge` allowlist (`memory.recall`, `workspace.memory.search`,
 * `workspace.context.snapshot`).
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { FinanceRecall } from "../context/finance-recall";
import { getExperienceBus, getExperienceStore } from "../experience";
import { ExperienceRecall } from "../experience/pipes/recall";
import { isDeliveryNarrative } from "../conversation/turn-packet";
import { buildWorkspaceBootstrapPack, openWorkspaceById, resolveProviders } from "../workspace";
import type { BuiltinToolHandler } from "./types";

export type MemoryRecallHit = {
  title: string;
  summary: string;
  sub_kind?: string;
  score: number;
  source: "experience" | "fs";
};

/** FS workspace id from params (not Core `wf_*` session workspace). */
export function resolveFsWorkspaceIdFromParams(
  params: Record<string, unknown>
): string | null {
  const direct =
    (typeof params.fs_workspace_id === "string" && params.fs_workspace_id.trim()) ||
    (typeof params.fsWorkspaceId === "string" && params.fsWorkspaceId.trim()) ||
    "";
  if (direct) return direct;

  const raw =
    (typeof params.workspace_id === "string" && params.workspace_id.trim()) ||
    (typeof params.workspaceId === "string" && params.workspaceId.trim()) ||
    "";
  if (!raw || raw.startsWith("wf_")) return null;
  return raw;
}

async function resolveProjectId(
  ctx: { projectId?: string; workflowId?: string },
  params: Record<string, unknown>
): Promise<string> {
  const fromParams =
    (typeof params.project_id === "string" && params.project_id.trim()) ||
    (typeof params.projectId === "string" && params.projectId.trim()) ||
    "";
  if (fromParams) return fromParams;
  if (ctx.projectId?.trim()) return ctx.projectId.trim();
  if (!ctx.workflowId) return "";
  const db = await getDb();
  const row = (
    await db
      .select({ projectId: workflowRun.projectId })
      .from(workflowRun)
      .where(eq(workflowRun.id, ctx.workflowId))
      .limit(1)
  )[0];
  return row?.projectId ?? "";
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function searchFsMemory(
  workspaceId: string,
  query: string,
  topK: number
): Promise<MemoryRecallHit[]> {
  const { fs, manifest } = await openWorkspaceById(workspaceId);
  const { memory } = resolveProviders(manifest, { allowBuiltinFallback: true });
  const rows = await memory.search(fs, query, { limit: topK });
  return rows.map((e) => ({
    title: e.title || e.id,
    summary: truncate(e.body ?? "", 400),
    sub_kind: "fs",
    score: typeof e.score === "number" ? e.score : 0,
    source: "fs" as const,
  }));
}

export const PRIME_MEMORY_HANDLERS: Record<string, BuiltinToolHandler> = {
  "memory.recall": async (ctx, params) => {
    const query = String(params.query ?? params.q ?? "").trim();
    if (!query) throw new Error("memory.recall: query is required");
    const topK = Math.max(1, Math.min(20, Number(params.topK ?? params.top_k ?? 8) || 8));
    const mode = String(params.mode ?? "").trim().toLowerCase();
    const projectId = await resolveProjectId(ctx, params);
    if (!projectId) {
      throw new Error("memory.recall: project_id required (or workflow must bind a project)");
    }

    const includeFs =
      params.include_fs === true ||
      params.includeFs === true ||
      Boolean(resolveFsWorkspaceIdFromParams(params));
    const fsWorkspaceId = resolveFsWorkspaceIdFromParams(params);

    const { getDefaultEmbeddingClient } = await import("../llm/embedding-client");
    const { getExperienceVectorStore } = await import("../experience/experience-vector-store");
    const embeddingClient = getDefaultEmbeddingClient();
    const recallOpts = {
      store: getExperienceStore(),
      bus: getExperienceBus(),
      ...(embeddingClient
        ? { embeddingClient, vectorStore: getExperienceVectorStore() }
        : {}),
    };

    const recallCtx = {
      projectId,
      definitionId: ctx.definition?.id ?? null,
      query,
      topK,
      workflowRunId: ctx.workflowId,
      silentEmit: true,
      ...(fsWorkspaceId ? { workspaceId: fsWorkspaceId } : {}),
    };

    const hits: MemoryRecallHit[] = [];
    const bundle = mode === "bundle" || params.bundle === true;

    const pushFinance = async () => {
      const financeRecall = new FinanceRecall(recallOpts);
      const financeHits = await financeRecall.recall(recallCtx);
      for (const h of financeHits) {
        const exp = h.experience;
        hits.push({
          title: truncate(exp.contentJson.summary ?? exp.id, 120),
          summary: truncate(String(exp.contentJson.body ?? exp.contentJson.summary ?? ""), 400),
          sub_kind: exp.subKind ?? "finance",
          score: h.score,
          source: "experience",
        });
      }
    };

    const pushExperience = async (
      subKindFallback: string,
      kinds?: Array<"episodic" | "semantic" | "procedural" | "reflective">
    ) => {
      const recall = new ExperienceRecall(recallOpts);
      const results = await recall.recall({
        ...recallCtx,
        ...(kinds ? { kinds } : {}),
      });
      for (const h of results) {
        const exp = h.experience;
        hits.push({
          title: truncate(exp.contentJson.summary ?? exp.id, 120),
          summary: truncate(String(exp.contentJson.body ?? exp.contentJson.summary ?? ""), 400),
          sub_kind: exp.subKind ?? subKindFallback,
          score: h.score,
          source: "experience",
        });
      }
    };

    if (bundle) {
      // Core assemble: one bridge call = finance + experience + optional FS.
      await pushFinance();
      await pushExperience("procedural", ["procedural"]);
    } else if (mode === "finance") {
      await pushFinance();
    } else {
      const wantProcedural =
        Array.isArray(params.kinds) && params.kinds.includes("procedural");
      await pushExperience(
        wantProcedural ? "procedural" : "note",
        wantProcedural ? ["procedural"] : undefined
      );
    }

    if ((includeFs || bundle) && fsWorkspaceId) {
      try {
        const fsHits = await searchFsMemory(fsWorkspaceId, query, topK);
        hits.push(
          ...fsHits.map((h) => ({
            ...h,
            sub_kind: h.sub_kind ?? "fs",
          }))
        );
      } catch (err) {
        console.warn(
          `[memory.recall] fs search failed workspace=${fsWorkspaceId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    hits.sort((a, b) => b.score - a.score);
    // Demote FS / experience blobs that look like prior delivery manuals (Host filter).
    const demoted = hits.map((h) => {
      const blob = `${h.title}\n${h.summary}`;
      if (!isDeliveryNarrative(blob) && !/人肉说明书|操盘说明书/.test(blob)) return h;
      return { ...h, score: h.score * 0.12, sub_kind: h.sub_kind ?? "delivered_artifact" };
    });
    demoted.sort((a, b) => b.score - a.score);
    // Bundle returns a bit more so Core can partition into three slots.
    return {
      hits: demoted.slice(0, bundle ? topK * 3 : topK * 2),
      ...(bundle ? { mode: "bundle" } : {}),
    };
  },

  "workspace.memory.search": async (_ctx, params) => {
    const query = String(params.query ?? params.q ?? "").trim();
    if (!query) throw new Error("workspace.memory.search: query is required");
    const workspaceId = resolveFsWorkspaceIdFromParams(params);
    if (!workspaceId) {
      // Core often only has wf_<uuid>; soft-empty so agent can continue with memory.recall.
      return {
        workspaceId: null,
        query,
        results: [],
        skipped: true,
        reason: "no_fs_workspace_id",
        summary:
          "workspace.memory.search skipped: Core session workspace (wf_*) is not an FS workspace. Prefer memory.recall({query}) or pass fs_workspace_id.",
      };
    }
    const topK = Math.max(1, Math.min(50, Number(params.topK ?? params.top_k ?? 20) || 20));
    const { fs, manifest } = await openWorkspaceById(workspaceId);
    const { memory } = resolveProviders(manifest, { allowBuiltinFallback: true });
    const rows = await memory.search(fs, query, { limit: topK });
    return {
      workspaceId: manifest.id,
      query,
      results: rows.map((e) => ({
        id: e.id,
        title: e.title,
        body: e.body,
        tags: e.tags ?? [],
        pinned: Boolean(e.pinned),
        score: e.score ?? 0,
        source: e.source ?? "user",
        updatedAt: e.updatedAt,
      })),
    };
  },

  "workspace.context.snapshot": async (_ctx, params) => {
    const workspaceId = resolveFsWorkspaceIdFromParams(params);
    if (!workspaceId) {
      // Soft-empty: Core injects wf_* as workspace_id; FS pack is optional for research turns.
      return {
        context_block:
          "(no FS workspace bound — Core session uses wf_* id only; continue without workspace rules)",
        skipped: true,
        reason: "no_fs_workspace_id",
      };
    }
    const pack = await buildWorkspaceBootstrapPack(workspaceId);
    const openFilesRaw = params.open_files ?? params.openFiles;
    const open_files = Array.isArray(openFilesRaw)
      ? openFilesRaw.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      : undefined;

    let context_block = pack.contextBlock;
    if (open_files?.length) {
      context_block = `${context_block}\n\n### Open files\n${open_files.map((f) => `- ${f}`).join("\n")}`;
    }

    const rulesCount = pack.instructionsText
      ? pack.instructionsText.split(/^### /m).filter((s) => s.trim()).length
      : 0;

    return {
      context_block,
      ...(open_files?.length ? { open_files } : {}),
      ...(rulesCount > 0 ? { rules_count: rulesCount } : {}),
    };
  },
};
