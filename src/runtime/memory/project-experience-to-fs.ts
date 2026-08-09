/**
 * Experience → FS memory/entries 投影（docs/qubit-prime/05 §4.4 B）。
 *
 * 规则闸门：仅高质量 semantic/procedural 摘要；delivery 叙事拒绝。
 * 幂等 id：`exp_<experienceId>`，source=`agent_proposal`。
 */
import type { Experience } from "../../types/entities";
import { isDeliveryNarrative } from "../conversation/turn-packet";
import { openWorkspaceById, resolveProviders } from "../workspace";
import type { MemoryEntry } from "../workspace/types";

/** SubKinds that always project (even at modest quality). */
const ALWAYS_PROJECT_SUBKINDS = new Set([
  "iteration_summary",
  "research_conclusion",
  "factor_archive",
  "workflow_summary",
  "regime",
  "workflow_play",
]);

const MIN_QUALITY = 0.55;

export function projectedFsEntryId(experienceId: string): string {
  return `exp_${experienceId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80)}`;
}

export function shouldProjectExperienceToFs(exp: Experience): boolean {
  if (exp.validTo != null) return false;
  if (exp.kind !== "semantic" && exp.kind !== "procedural") return false;
  const sub = (exp.subKind ?? "").trim();
  const quality = typeof exp.qualityScore === "number" ? exp.qualityScore : 0;
  if (!ALWAYS_PROJECT_SUBKINDS.has(sub) && quality < MIN_QUALITY) return false;

  const blob = `${exp.contentJson.summary ?? ""}\n${exp.contentJson.body ?? ""}`;
  if (!blob.trim()) return false;
  if (isDeliveryNarrative(blob)) return false;
  if (/人肉说明书|操盘说明书/.test(blob)) return false;
  return true;
}

export type ProjectExperienceResult =
  | { ok: true; entry: MemoryEntry; skipped?: undefined }
  | { ok: false; skipped: string; entry?: undefined };

export async function projectExperienceToFs(
  fsWorkspaceId: string,
  exp: Experience
): Promise<ProjectExperienceResult> {
  if (!shouldProjectExperienceToFs(exp)) {
    return { ok: false, skipped: "gate_rejected" };
  }
  const { fs, manifest } = await openWorkspaceById(fsWorkspaceId);
  const { memory } = resolveProviders(manifest, { allowBuiltinFallback: true });
  const id = projectedFsEntryId(exp.id);
  const title =
    (exp.contentJson.summary ?? "").trim().slice(0, 120) ||
    `${exp.kind}${exp.subKind ? `/${exp.subKind}` : ""}`;
  const body = String(exp.contentJson.body ?? exp.contentJson.summary ?? "").trim();
  const tags = [
    "experience",
    `kind:${exp.kind}`,
    ...(exp.subKind ? [`sub:${exp.subKind}`] : []),
    ...(Array.isArray(exp.tagsJson) ? exp.tagsJson.slice(0, 8) : []),
  ];
  const entry = await memory.upsert(fs, {
    id,
    title,
    body,
    source: "agent_proposal",
    tags,
    pinned: Boolean(exp.pinned),
  });
  return { ok: true, entry };
}

/** Fire-and-forget batch after Extractor / Reflector writes. */
export async function projectExperiencesToFs(
  fsWorkspaceId: string | null | undefined,
  experiences: Experience[]
): Promise<{ projected: number; skipped: number }> {
  const ws = fsWorkspaceId?.trim();
  if (!ws || experiences.length === 0) return { projected: 0, skipped: experiences.length };
  let projected = 0;
  let skipped = 0;
  for (const exp of experiences) {
    try {
      const r = await projectExperienceToFs(ws, exp);
      if (r.ok) projected += 1;
      else skipped += 1;
    } catch (err) {
      skipped += 1;
      console.warn(
        `[ltm.project] failed exp=${exp.id} ws=${ws}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return { projected, skipped };
}
