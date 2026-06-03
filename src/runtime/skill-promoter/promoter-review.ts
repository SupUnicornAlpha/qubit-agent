/**
 * Self-Evolving Agent P5 — SkillPromotion 审批 handler。
 *
 * 提供两个动作：
 *   - approveSkillPromotion(skillId, opts)：把 pending_review 翻 active；写 promotion_review_at；
 *     bump lastPromotedAt / lastUsedAt（让 recall 排序立刻能看到这个新 skill）。
 *   - rejectSkillPromotion(skillId, opts)：把 pending_review 翻 archived；写 reflective(skill_reject_feedback)
 *     带 signature，让下次 promoter 跑批跳过该 signature。
 *
 * 分模块的好处：worker、routes、test 都可以单独调；不绑死 Hono。
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill as agentSkillTable } from "../../db/sqlite/schema";
import type { ExperienceStore } from "../experience/experience-store";
import { getExperienceStore } from "../experience/experience-store";
import { parseSignatureFromBody } from "./skill-promoter";

export interface ApproveOptions {
  /** 谁批准的：'user' | 'auto'（P6 用） */
  actor?: string;
  /** 可选：再 patch 一下 description（用户在 UI 上能 edit） */
  description?: string;
}

export interface RejectOptions {
  actor?: string;
  /** 用户填写的驳回理由；落进 reflective(content.body) 给将来 Reflector 用 */
  reason?: string;
}

export interface ReviewResult {
  skillId: string;
  prevState: string;
  nextState: string;
  signature: string | null;
  reflectiveExperienceId?: string;
}

export async function approveSkillPromotion(
  skillId: string,
  opts: ApproveOptions = {}
): Promise<ReviewResult> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentSkillTable)
    .where(eq(agentSkillTable.id, skillId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`approveSkillPromotion: skill ${skillId} not found`);
  if (row.state !== "pending_review") {
    throw new Error(
      `approveSkillPromotion: skill ${skillId} state=${row.state}, only pending_review can be approved`
    );
  }
  const now = new Date().toISOString();
  const setters: Record<string, unknown> = {
    state: "active",
    promotionReviewAt: now,
    lastPromotedAt: now,
    updatedAt: now,
  };
  if (typeof opts.description === "string") {
    setters.description = opts.description.slice(0, 240);
  }
  await db.update(agentSkillTable).set(setters).where(eq(agentSkillTable.id, skillId));
  return {
    skillId,
    prevState: row.state,
    nextState: "active",
    signature: parseSignatureFromBody(row.bodyMd),
  };
}

export async function rejectSkillPromotion(
  skillId: string,
  opts: RejectOptions = {},
  store: ExperienceStore = getExperienceStore()
): Promise<ReviewResult> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(agentSkillTable)
    .where(eq(agentSkillTable.id, skillId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`rejectSkillPromotion: skill ${skillId} not found`);
  if (row.state !== "pending_review") {
    throw new Error(
      `rejectSkillPromotion: skill ${skillId} state=${row.state}, only pending_review can be rejected`
    );
  }
  const now = new Date().toISOString();
  const signature = parseSignatureFromBody(row.bodyMd);
  await db
    .update(agentSkillTable)
    .set({
      state: "archived",
      promotionReviewAt: now,
      updatedAt: now,
    })
    .where(eq(agentSkillTable.id, skillId));

  // 写一条 reflective 反馈：下次 promoter 跑批跳过同 signature
  // 注：signature 可空（极少数：用户人为改过 bodyMd 删了 marker） — 那就只记 skillId，
  //    promoter 那侧用 signature 集合去重；signature=null 时本条不影响去重，只是审计。
  let reflectiveId: string | undefined;
  if (signature) {
    const exp = await store.insert({
      kind: "reflective",
      subKind: "skill_reject_feedback",
      scope: "project",
      scopeId: row.projectId,
      definitionId: row.definitionId ?? null,
      visibility: "project_shared",
      contentJson: {
        summary: `驳回 promoted skill "${row.name}"`,
        body:
          (opts.reason && opts.reason.trim().length > 0
            ? opts.reason.trim()
            : "（无理由说明）") + `\n\nsignature: ${signature}\nskillId: ${skillId}`,
      },
      tagsJson: ["promoter", "reject", `actor:${opts.actor ?? "user"}`],
      metadataJson: { signature, rejectedSkillId: skillId, actor: opts.actor ?? "user" },
      validFrom: now,
      qualityScore: 0.5,
    });
    reflectiveId = exp.id;
  }

  return {
    skillId,
    prevState: row.state,
    nextState: "archived",
    signature,
    ...(reflectiveId ? { reflectiveExperienceId: reflectiveId } : {}),
  };
}
