/**
 * P6 工具函数：写一条 reflective(skill_revision_request) 到 ExperienceStore，
 * 让 SkillEvolverWatcher 下次跑批时自动处理。
 *
 * 设计原则：
 *   - 任何模块都可以调（Reflector / Janitor / 用户手动 trigger / 后端 routes）；
 *   - 同 (projectId, baseSkillId) 在 X 小时内只能存在一条 pending 请求，避免短时间内
 *     对同一 skill 发起重复 evolve（昂贵）。
 *   - 不直接调 SkillEvolver.evolve —— 那是 worker 的责任。
 */

import type { ExperienceStore } from "../experience/experience-store";
import { getExperienceStore } from "../experience/experience-store";
import type { SkillRevisionRequestMeta } from "./types";

const REQUEST_SUBKIND = "skill_revision_request";
const DEDUP_WINDOW_HOURS = 6;

export interface RequestSkillRevisionInput {
  projectId: string;
  baseSkillId: string;
  requestedBy: string;
  reason?: string;
  /** 可选关联：Reflector 拿到的 reflective experience id（→ experience_link 关系） */
  sourceReflectiveExperienceId?: string;
  iterations?: number;
  candidatesPerIteration?: number;
  /** 时间窗口去重；默认 6h 内同 (projectId, baseSkillId) 只一条 pending */
  dedupWindowHours?: number;
}

export interface RequestSkillRevisionResult {
  /** 'created' 写入新请求 / 'deduped' 命中窗口内已存在的 pending */
  status: "created" | "deduped";
  experienceId: string;
}

export async function requestSkillRevision(
  input: RequestSkillRevisionInput,
  store: ExperienceStore = getExperienceStore()
): Promise<RequestSkillRevisionResult> {
  if (!input.projectId) throw new Error("requestSkillRevision: projectId required");
  if (!input.baseSkillId) throw new Error("requestSkillRevision: baseSkillId required");

  const dedupHours = input.dedupWindowHours ?? DEDUP_WINDOW_HOURS;
  const cutoffMs = Date.now() - dedupHours * 3600_000;

  // 查窗口内最近的请求：同 baseSkillId 且尚未 processed
  const recent = await store.query({
    kind: "reflective",
    subKind: REQUEST_SUBKIND,
    scope: "project",
    scopeId: input.projectId,
    archivalMode: "all",
    orderBy: "created_desc",
    limit: 100,
  });
  for (const r of recent) {
    const meta = r.metadataJson as Record<string, unknown> | null;
    if (!meta || meta.baseSkillId !== input.baseSkillId) continue;
    // 已处理 → 不去重，新请求是合法的（人为再发起意味着想再 evolve 一次）
    if (typeof meta.processedAt === "string") continue;
    // 未处理 + 在窗口内 → 去重
    const createdAtMs = Date.parse(r.createdAt);
    if (Number.isFinite(createdAtMs) && createdAtMs >= cutoffMs) {
      return { status: "deduped", experienceId: r.id };
    }
  }

  const meta: SkillRevisionRequestMeta = {
    baseSkillId: input.baseSkillId,
    requestedBy: input.requestedBy,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.iterations ? { iterations: input.iterations } : {}),
    ...(input.candidatesPerIteration
      ? { candidatesPerIteration: input.candidatesPerIteration }
      : {}),
  };

  const exp = await store.insert({
    kind: "reflective",
    subKind: REQUEST_SUBKIND,
    scope: "project",
    scopeId: input.projectId,
    visibility: "project_shared",
    contentJson: {
      summary: `请求修订 skill ${input.baseSkillId}`,
      body:
        (input.reason ?? "").trim() ||
        `requestedBy=${input.requestedBy}（无 reason）`,
    },
    tagsJson: ["p6", "skill_evolver", `requestedBy:${input.requestedBy}`],
    metadataJson: meta as unknown as Record<string, unknown>,
    validFrom: new Date().toISOString(),
    qualityScore: 0.5,
  });

  if (input.sourceReflectiveExperienceId) {
    try {
      await store.linkAdd(exp.id, input.sourceReflectiveExperienceId, "derive_from", 1.0);
    } catch {
      /* link 失败不影响主体写入 */
    }
  }

  return { status: "created", experienceId: exp.id };
}

export const SKILL_REVISION_SUBKIND = REQUEST_SUBKIND;
