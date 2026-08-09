/**
 * Long-term memory multi-path facade（docs/qubit-prime/05 §4.4 A+B）。
 *
 * - Experience（Memory V2）：主热路径 / 规则闸门
 * - FS Workspace `memory/entries`：code-agent 式可见课题记忆
 * - MemoryRouter（可选）：Mem0 等 dual_write，失败不阻塞
 *
 * 不新开第三套 LTM 表。
 */
import { config } from "../../config";
import type { Experience } from "../../types/entities";
import { isDeliveryNarrative } from "../conversation/turn-packet";
import { getExperienceBus, getExperienceStore } from "../experience";
import { ExperienceRecall } from "../experience/pipes/recall";
import { openWorkspaceById, resolveProviders } from "../workspace";
import type { MemoryEntry } from "../workspace/types";
import { resolveActiveFsWorkspaceId } from "./fs-workspace-id";
import {
  projectExperienceToFs,
  projectedFsEntryId,
  projectExperiencesToFs,
  shouldProjectExperienceToFs,
} from "./project-experience-to-fs";

export type LongTermHitSource = "experience" | "fs" | "external";

export type LongTermRecallHit = {
  title: string;
  summary: string;
  sub_kind?: string;
  score: number;
  source: LongTermHitSource;
  id?: string;
};

export type RecallLongTermInput = {
  projectId: string;
  query: string;
  topK?: number;
  definitionId?: string | null;
  role?: string;
  workflowId?: string | null;
  /** Prefer explicit; otherwise resolved from workflow / env. */
  fsWorkspaceId?: string | null;
  includeFs?: boolean;
  kinds?: Array<"episodic" | "semantic" | "procedural" | "reflective">;
  silentEmit?: boolean;
};

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

async function searchFsMemory(
  workspaceId: string,
  query: string,
  topK: number
): Promise<LongTermRecallHit[]> {
  const { fs, manifest } = await openWorkspaceById(workspaceId);
  const { memory } = resolveProviders(manifest, { allowBuiltinFallback: true });
  const rows = await memory.search(fs, query, { limit: topK });
  return rows.map((e) => ({
    id: e.id,
    title: e.title || e.id,
    summary: truncate(e.body ?? "", 400),
    sub_kind: "fs",
    score: typeof e.score === "number" ? e.score : 0,
    source: "fs" as const,
  }));
}

async function maybeMirrorExternal(
  content: string,
  meta: {
    layer: "longterm";
    projectId?: string;
    workspaceId?: string;
    tags?: string[];
  }
): Promise<void> {
  if (!config.memory.external.enabled) return;
  if (config.memory.external.writeMode === "native_only") return;
  try {
    const { createMemoryRouter } = await import("../../connectors/memory/memory.router");
    const router = createMemoryRouter({
      writeMode: config.memory.external.writeMode,
      fallbackToNative: true,
    });
    await router.add(content, {
      layer: meta.layer,
      ...(meta.projectId ? { projectId: meta.projectId } : {}),
      ...(meta.workspaceId ? { workspaceId: meta.workspaceId } : {}),
      ...(meta.tags ? { tags: meta.tags } : {}),
      asofTime: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(
      "[ltm.external] mirror skipped:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Dual recall: Experience (workspace+project scopes) + optional FS workspace memory.
 */
export async function recallLongTermMemory(
  input: RecallLongTermInput
): Promise<LongTermRecallHit[]> {
  const topK = Math.max(1, Math.min(20, input.topK ?? 8));
  let fsWorkspaceId: string | null =
    input.fsWorkspaceId?.trim() && !input.fsWorkspaceId.startsWith("wf_")
      ? input.fsWorkspaceId.trim()
      : null;
  if (!fsWorkspaceId) {
    fsWorkspaceId = await resolveActiveFsWorkspaceId(
      input.workflowId ? { workflowId: input.workflowId } : {}
    );
  }

  const includeFs = input.includeFs !== false && Boolean(fsWorkspaceId);

  const { getDefaultEmbeddingClient } = await import("../llm/embedding-client");
  const { getExperienceVectorStore } = await import("../experience/experience-vector-store");
  const embeddingClient = getDefaultEmbeddingClient();
  const recall = new ExperienceRecall({
    store: getExperienceStore(),
    bus: getExperienceBus(),
    ...(embeddingClient
      ? { embeddingClient, vectorStore: getExperienceVectorStore() }
      : {}),
  });

  const results = await recall.recall({
    projectId: input.projectId,
    definitionId: input.definitionId ?? null,
    query: input.query,
    topK,
    silentEmit: input.silentEmit ?? true,
    ...(input.role ? { role: input.role } : {}),
    ...(input.workflowId ? { workflowRunId: input.workflowId } : {}),
    ...(input.kinds ? { kinds: input.kinds } : {}),
    ...(fsWorkspaceId ? { workspaceId: fsWorkspaceId } : {}),
  });

  const hits: LongTermRecallHit[] = results.map((h) => ({
    id: h.experience.id,
    title: truncate(h.experience.contentJson.summary ?? h.experience.id, 120),
    summary: truncate(
      String(h.experience.contentJson.body ?? h.experience.contentJson.summary ?? ""),
      400
    ),
    sub_kind: h.experience.subKind ?? h.experience.kind,
    score: h.score,
    source: "experience" as const,
  }));

  if (includeFs && fsWorkspaceId) {
    try {
      hits.push(...(await searchFsMemory(fsWorkspaceId, input.query, topK)));
    } catch (err) {
      console.warn(
        `[ltm.recall] fs search failed workspace=${fsWorkspaceId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const demoted = hits.map((h) => {
    const blob = `${h.title}\n${h.summary}`;
    if (!isDeliveryNarrative(blob) && !/人肉说明书|操盘说明书/.test(blob)) return h;
    return { ...h, score: h.score * 0.12, sub_kind: h.sub_kind ?? "delivered_artifact" };
  });
  demoted.sort((a, b) => b.score - a.score);
  return demoted.slice(0, topK * 2);
}

/**
 * Workspace 面板可见层：FS 笔记 + 未投影的 Experience（scope=workspace）。
 */
export async function listMergedWorkspaceMemory(
  fsWorkspaceId: string,
  opts?: { q?: string; pinned?: boolean; limit?: number }
): Promise<MemoryEntry[]> {
  const limit = opts?.limit && opts.limit > 0 ? opts.limit : 60;
  const q = opts?.q?.trim().toLowerCase() ?? "";

  const { fs, manifest } = await openWorkspaceById(fsWorkspaceId);
  const { memory } = resolveProviders(manifest, { allowBuiltinFallback: true });

  let fsRows: MemoryEntry[] = q
    ? await memory.search(fs, q, { limit })
    : await memory.list(fs, {
        ...(opts?.pinned !== undefined ? { pinned: opts.pinned } : {}),
        limit,
      });

  const projectedIds = new Set(
    fsRows.filter((r) => r.id.startsWith("exp_")).map((r) => r.id)
  );

  const store = getExperienceStore();
  const experiences = await store.query({
    scope: "workspace",
    scopeId: fsWorkspaceId,
    kind: ["semantic", "procedural", "reflective"],
    archivalMode: "exclude_archived",
    limit: Math.max(limit, 40),
    orderBy: "created_desc",
  });

  const virtual: MemoryEntry[] = [];
  for (const exp of experiences) {
    const pid = projectedFsEntryId(exp.id);
    if (projectedIds.has(pid)) continue;
    const title = (exp.contentJson.summary ?? exp.id).trim().slice(0, 120) || exp.id;
    const body = String(exp.contentJson.body ?? exp.contentJson.summary ?? "");
    if (q) {
      const hay = `${title}\n${body}\n${exp.subKind ?? ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    if (opts?.pinned != null && Boolean(exp.pinned) !== opts.pinned) continue;
    virtual.push({
      id: `experience:${exp.id}`,
      title,
      body,
      createdAt: exp.createdAt,
      updatedAt: exp.updatedAt ?? exp.createdAt,
      pinned: Boolean(exp.pinned),
      tags: [
        "experience",
        `kind:${exp.kind}`,
        ...(exp.subKind ? [`sub:${exp.subKind}`] : []),
      ],
      source: "experience",
    });
  }

  const merged = [...fsRows, ...virtual];
  merged.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return merged.slice(0, limit);
}

/**
 * After Experience pipes write: project eligible rows to FS + optional external mirror.
 */
export async function onExperiencesWritten(opts: {
  experiences: Experience[];
  fsWorkspaceId?: string | null;
  projectId?: string | null;
}): Promise<{ projected: number; skipped: number }> {
  const fsWorkspaceId =
    opts.fsWorkspaceId?.trim() ||
    (await resolveActiveFsWorkspaceId({})) ||
    null;
  const stats = await projectExperiencesToFs(fsWorkspaceId, opts.experiences);

  for (const exp of opts.experiences) {
    if (!shouldProjectExperienceToFs(exp)) continue;
    const content = String(exp.contentJson.summary ?? exp.contentJson.body ?? "").trim();
    if (!content) continue;
    void maybeMirrorExternal(content, {
      layer: "longterm",
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(fsWorkspaceId ? { workspaceId: fsWorkspaceId } : {}),
      tags: [`kind:${exp.kind}`, ...(exp.subKind ? [`sub:${exp.subKind}`] : [])],
    });
  }

  return stats;
}

export {
  projectExperienceToFs,
  projectExperiencesToFs,
  projectedFsEntryId,
  shouldProjectExperienceToFs,
};
