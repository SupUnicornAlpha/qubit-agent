/**
 * Self-Evolving Agent P5 — SkillPromoter worker。
 *
 * 职责：周期扫描某 project 下的高价值 procedural / reflective experience，
 *      按 scoring 规则筛 → 写 agent_skill(state='pending_review')，等用户审。
 *
 * 触发：cron 每 30 min（默认）+ 手动 API + 测试直接 runOnce。
 *
 * 候选来源（v0）：
 *   `experience(kind='procedural', sub_kind='workflow_play', scope='project', scopeId=projectId)`
 *   - metadataJson.signature 即去重 key
 *   - useCount / successCount / failCount / qualityScore 由 writer/recall/janitor pipe 维护
 *
 * 去重：
 *   - 候选 signature 已存在于 `agent_skill.bodyMd` 末尾 `<!-- signature: xxx -->`
 *     (兼容 reconciliation 同款约定) → skipped_duplicate
 *   - 候选 signature 在 `experience(kind='reflective', sub_kind='skill_reject_feedback')` 标记过
 *     → skipped_rejected（用户驳回过的不再骚扰）
 *
 * 模式：
 *   - dry_run（默认）：只评分、写 skill_promotion_run，不动 agent_skill
 *   - live：真的 upsert agent_skill(state='pending_review')
 *
 * 输出：一行 `skill_promotion_run` + actionsJson 候选明细 + emit metrics。
 *
 * 决策（用户审批）不在 worker 内：由后端 routes 直接 patch agent_skill 的 state，
 * 并 reject 时落一条 reflective 反馈（见 promoter-review.ts，单独文件单元测）。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentSkill as agentSkillTable,
  skillPromotionRun as skillPromotionRunTable,
} from "../../db/sqlite/schema";
import type { ExperienceBus } from "../experience/experience-bus";
import { getExperienceBus } from "../experience/experience-bus";
import type { ExperienceStore } from "../experience/experience-store";
import { getExperienceStore } from "../experience/experience-store";
import { DEFAULT_SCORING_CONFIG, type PromoterScoringConfig, scoreCandidate } from "./scoring";
import type {
  PromoterActionRecord,
  PromoterCandidate,
  PromoterRunSummary,
} from "./types";

const ACTIONS_CAP = 200;
const SIGNATURE_MARKER_PREFIX = "<!-- signature: ";
const SIGNATURE_MARKER_SUFFIX = " -->";

export interface SkillPromoterRunOptions {
  projectId: string;
  mode?: "dry_run" | "live";
  triggeredBy?: string;
  /** 覆盖默认评分配置；测试常用 */
  scoring?: PromoterScoringConfig;
  /** 是否 emit metrics（test 可关） */
  emitMetrics?: boolean;
}

export interface SkillPromoterDeps {
  store?: ExperienceStore;
  bus?: ExperienceBus;
}

export class SkillPromoter {
  private readonly store: ExperienceStore;
  private readonly bus: ExperienceBus;

  constructor(deps: SkillPromoterDeps = {}) {
    this.store = deps.store ?? getExperienceStore();
    this.bus = deps.bus ?? getExperienceBus();
  }

  async runOnce(opts: SkillPromoterRunOptions): Promise<PromoterRunSummary> {
    if (!opts.projectId) throw new Error("SkillPromoter.runOnce: projectId required");
    const mode = opts.mode ?? "dry_run";
    const triggeredBy = opts.triggeredBy ?? "cron";
    const cfg = opts.scoring ?? DEFAULT_SCORING_CONFIG;
    const startedAt = new Date();
    const startedIso = startedAt.toISOString();
    const runId = randomUUID();

    const db = await getDb();
    await db.insert(skillPromotionRunTable).values({
      id: runId,
      projectId: opts.projectId,
      mode,
      status: "running",
      triggeredBy,
      startedAt: startedIso,
    });

    const summary: PromoterRunSummary = {
      runId,
      projectId: opts.projectId,
      mode,
      status: "completed",
      triggeredBy,
      totalScanned: 0,
      totalQualified: 0,
      totalPromoted: 0,
      totalSkippedDuplicate: 0,
      totalSkippedInsufficient: 0,
      actions: [],
      elapsedMs: 0,
    };

    try {
      // ── 1) 拉候选（procedural.workflow_play） ──────────────
      const candidateRows = await this.store.query({
        kind: "procedural",
        subKind: "workflow_play",
        scope: "project",
        scopeId: opts.projectId,
        archivalMode: "exclude_archived",
        orderBy: "quality_desc",
        limit: 500,
      });

      const candidates: PromoterCandidate[] = [];
      for (const exp of candidateRows) {
        const sig = (exp.metadataJson as Record<string, unknown> | null)?.signature;
        if (typeof sig !== "string" || !sig) continue;
        candidates.push({
          kind: "procedural",
          experienceId: exp.id,
          signature: sig,
          title: deriveTitle(exp.contentJson.summary, sig),
          description: (exp.contentJson.summary ?? "").slice(0, 240),
          bodyMd:
            typeof exp.contentJson.body === "string"
              ? (exp.contentJson.body as string)
              : JSON.stringify(exp.contentJson.body ?? "", null, 2),
          definitionId: exp.definitionId ?? null,
          useCount: exp.useCount ?? 0,
          successCount: exp.successCount ?? 0,
          failCount: exp.failCount ?? 0,
          qualityScore: exp.qualityScore ?? 0,
          pnlSignal: 0.5,
        });
      }
      summary.totalScanned = candidates.length;

      // ── 2) 查已存在的 signature（去重） + 已驳回的 signature ─
      const [existingSigs, rejectedSigs] = await Promise.all([
        this.loadExistingSignatures(opts.projectId),
        this.loadRejectedSignatures(opts.projectId),
      ]);

      // ── 3) 评分 + 落库 ──────────────────────────────────
      for (const cand of candidates) {
        if (rejectedSigs.has(cand.signature)) {
          summary.actions.push(actionFor(cand, 0, false, "skipped_rejected", null, []));
          continue;
        }
        if (existingSigs.has(cand.signature)) {
          summary.totalSkippedDuplicate += 1;
          summary.actions.push(actionFor(cand, 0, false, "skipped_duplicate", null, []));
          continue;
        }
        const scored = scoreCandidate(cand, cfg);
        if (!scored.qualified) {
          if (
            scored.skipReason === "insufficient_data" ||
            scored.skipReason === "low_recall" ||
            scored.skipReason === "low_quality"
          ) {
            summary.totalSkippedInsufficient += 1;
          }
          summary.actions.push(
            actionFor(cand, scored.score, false, "dry_run", null, scored.ruleHits)
          );
          continue;
        }
        summary.totalQualified += 1;

        // dry_run 不实际写 agent_skill，但 actionsJson 保留候选用于前端预览
        if (mode === "dry_run") {
          summary.actions.push(
            actionFor(cand, scored.score, true, "dry_run", null, scored.ruleHits)
          );
          continue;
        }

        // live：真写 agent_skill(state='pending_review')
        const skillId = await this.promote(opts.projectId, runId, cand, scored.score);
        summary.totalPromoted += 1;
        summary.actions.push(
          actionFor(cand, scored.score, true, "promoted", skillId, scored.ruleHits)
        );
      }

      // 截断 actionsJson 避免大 payload
      if (summary.actions.length > ACTIONS_CAP) {
        summary.actions = summary.actions.slice(0, ACTIONS_CAP);
      }
    } catch (e) {
      summary.status = "failed";
      summary.errorMessage = e instanceof Error ? e.message : String(e);
    }

    summary.elapsedMs = Date.now() - startedAt.getTime();

    await db
      .update(skillPromotionRunTable)
      .set({
        status: summary.status,
        totalScanned: summary.totalScanned,
        totalQualified: summary.totalQualified,
        totalPromoted: summary.totalPromoted,
        totalSkippedDuplicate: summary.totalSkippedDuplicate,
        totalSkippedInsufficient: summary.totalSkippedInsufficient,
        actionsJson: summary.actions as unknown as never,
        elapsedMs: summary.elapsedMs,
        errorMessage: summary.errorMessage ?? null,
        endedAt: new Date().toISOString(),
      })
      .where(eq(skillPromotionRunTable.id, runId));

    if (opts.emitMetrics !== false) {
      try {
        this.bus.emit({
          type: "maintenance_run",
          kind: "skill_promoter",
          actor: "skill_promoter",
          summary: {
            scanned: summary.totalScanned,
            qualified: summary.totalQualified,
            promoted: summary.totalPromoted,
            skippedDuplicate: summary.totalSkippedDuplicate,
            skippedInsufficient: summary.totalSkippedInsufficient,
            mode: summary.mode,
            status: summary.status,
          },
        });
      } catch {
        /* metrics 失败不影响主流程 */
      }
    }

    return summary;
  }

  // ───────────────────────── 私有 helper ─────────────────────────

  /** 扫 agent_skill 取已存在 signature；用 bodyMd 末尾的 `<!-- signature: xxx -->` 注释解析 */
  private async loadExistingSignatures(projectId: string): Promise<Set<string>> {
    const db = await getDb();
    const rows = await db
      .select({ bodyMd: agentSkillTable.bodyMd })
      .from(agentSkillTable)
      .where(
        and(
          eq(agentSkillTable.projectId, projectId),
          inArray(agentSkillTable.state, ["pending_review", "active", "stale"])
        )
      );
    const out = new Set<string>();
    for (const r of rows) {
      const sig = parseSignatureFromBody(r.bodyMd);
      if (sig) out.add(sig);
    }
    return out;
  }

  /** 扫 reflective(skill_reject_feedback) 取被拒绝的 signature */
  private async loadRejectedSignatures(projectId: string): Promise<Set<string>> {
    const rows = await this.store.query({
      kind: "reflective",
      subKind: "skill_reject_feedback",
      scope: "project",
      scopeId: projectId,
      archivalMode: "all",
      limit: 1000,
    });
    const out = new Set<string>();
    for (const r of rows) {
      const sig = (r.metadataJson as Record<string, unknown> | null)?.signature;
      if (typeof sig === "string") out.add(sig);
    }
    return out;
  }

  /** insert agent_skill(state='pending_review')，bodyMd 末尾打 signature marker */
  private async promote(
    projectId: string,
    runId: string,
    cand: PromoterCandidate,
    score: number
  ): Promise<string> {
    const db = await getDb();
    const skillId = randomUUID();
    const now = new Date().toISOString();
    const name = normalizeSkillName(cand.title);
    const bodyMd = `${cand.bodyMd.trimEnd()}\n\n${SIGNATURE_MARKER_PREFIX}${cand.signature}${SIGNATURE_MARKER_SUFFIX}\n`;

    // 同名 skill 已存在 → 退化为 skip_duplicate（不抛错；上层会标 skipped_duplicate）
    const sameName = await db
      .select({ id: agentSkillTable.id })
      .from(agentSkillTable)
      .where(and(eq(agentSkillTable.projectId, projectId), eq(agentSkillTable.name, name)))
      .limit(1);
    if (sameName[0]) return sameName[0].id;

    await db.insert(agentSkillTable).values({
      id: skillId,
      projectId,
      definitionId: cand.definitionId,
      name,
      description: cand.description,
      bodyMd,
      category: "promoted_procedural",
      version: "v1",
      parentSkillId: null,
      source: "agent_created",
      state: "pending_review",
      pinned: false,
      useCount: 0,
      successCount: 0,
      failCount: 0,
      lastUsedAt: null,
      metadataJson: { signature: cand.signature, sourceExperienceId: cand.experienceId },
      createdBy: "skill_promoter",
      pnlAttributionJson: "{}" as unknown as never,
      lastPromotedAt: now,
      evolutionMode: "manual",
      promotionRunId: runId,
      promotionScore: score,
      promotionReviewAt: null,
      createdAt: now,
      updatedAt: now,
    });
    return skillId;
  }
}

// ───────────────────────── helpers（exported for test） ─────────────────────────

function actionFor(
  c: PromoterCandidate,
  score: number,
  qualified: boolean,
  status: PromoterActionRecord["status"],
  promotedSkillId: string | null,
  ruleHits: PromoterActionRecord["ruleHits"]
): PromoterActionRecord {
  return {
    candidateKind: c.kind,
    experienceId: c.experienceId,
    signature: c.signature,
    score,
    qualified,
    promotedSkillId,
    status,
    ruleHits,
  };
}

export function parseSignatureFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const idx = body.lastIndexOf(SIGNATURE_MARKER_PREFIX);
  if (idx < 0) return null;
  const end = body.indexOf(SIGNATURE_MARKER_SUFFIX, idx);
  if (end < 0) return null;
  return body.slice(idx + SIGNATURE_MARKER_PREFIX.length, end).trim();
}

export function deriveTitle(summary: string | undefined, signature: string): string {
  const base = (summary ?? "").trim();
  if (base.length > 0) {
    const cleaned = base.split("\n")[0]!.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    return cleaned.slice(0, 80);
  }
  // fallback：用 signature 前几节当名字
  const parts = signature.split(">").slice(0, 3);
  return `auto-play: ${parts.join("→")}`.slice(0, 80);
}

export function normalizeSkillName(raw: string): string {
  const ascii = raw
    .replace(/\s+/g, " ")
    .replace(/[\\/`*_~|<>{}\[\]()'"]/g, "")
    .trim();
  if (ascii.length > 0) return ascii.slice(0, 64);
  return `auto-skill-${randomUUID().slice(0, 8)}`;
}
