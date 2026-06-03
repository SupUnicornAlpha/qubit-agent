/**
 * Self-Evolving Agent P9 — SkillBaselineObserver。
 *
 * 责任：
 *   每次 SkillEvolver 产出的"进化 skill"默认是 `state=pending_review`；
 *   本 worker 周期性扫这些 skill，按 **召回观察期** 标准决定：
 *     - 在 reason 节点被自然召回 ≥ minRecalls 次
 *     - 这些召回里 executed=true 的 `agent_skill_run.outcome=success` 比例 ≥ threshold
 *   达到 → 自动 `approveSkillPromotion(actor='skill_baseline_observer')` 翻 active
 *   不到 → 保持 pending_review，等下次 worker（不主动 archive，避免误杀）
 *
 * 选这个口径而不是 dataset replay 的原因：
 *   - 零基建：复用 P5 已有 skill_recall_log + agent_skill_run
 *   - 真实信号：是被真实 reason 节点召回 → 真实 act 执行的结果
 *   - 自然反馈：召回多说明 LLM 觉得"语义相关"；outcome 好说明"真的有用"
 *   缺点是要等数据自然累积（typically 7~14 天），dataset replay 是 P10 工作量
 *
 * gate：SELF_EVOLVE_ENABLED；关掉直接 early return（带 reason）
 *
 * 字段读取 caveat：
 *   - agent_skill_run.outcome 来自 skillService.recordUsage（reason 节点没强约束所有 ToolNode 都调）
 *   - 若 outcome='unknown' 多 → 视作无信号，不计入 success/fail 分母（防止把 unknown 当 fail）
 */

import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";

import { getDb } from "../../db/sqlite/client.js";
import { agentSkill, agentSkillRun, skillRecallLog } from "../../db/sqlite/schema.js";
import {
  getSelfEvolveConfig,
  selfEvolveDisabledReason,
} from "../config/self-evolve-config.js";
import { getExperienceBus, type ExperienceBus } from "../experience/experience-bus.js";
import { approveSkillPromotion } from "../skill-promoter/promoter-review.js";

export interface SkillBaselineObserverOptions {
  projectId: string;
  /** 观察窗口（天）：只看 startedAt 在 N 天内的 run；默认 14 */
  observationWindowDays?: number;
  /** 至少观察期内累计召回 N 次；默认 3 */
  minRecallCount?: number;
  /** 至少观察期内有 N 个 outcome != 'unknown' 的 run；默认 2 */
  minSignaledRuns?: number;
  /** success / (success+fail+partial) ≥ threshold；默认 0.6 */
  minSuccessRate?: number;
  /** 单次最多 enable N 条；防爆量；默认 20 */
  maxApprovesPerRun?: number;
  triggeredBy?: string;
  emitMetrics?: boolean;
}

export interface SkillBaselineObserverSummary {
  status: "completed" | "failed" | "disabled";
  reason?: string;
  scanned: number;
  approved: number;
  notReady: number;
  errors: number;
  results: Array<{
    skillId: string;
    name: string;
    action: "approved" | "not_ready" | "error";
    recallCount: number;
    signaledRunCount: number;
    successCount: number;
    failCount: number;
    successRate: number;
    reason?: string;
  }>;
  elapsedMs: number;
}

export class SkillBaselineObserver {
  constructor(private readonly bus: ExperienceBus = getExperienceBus()) {}

  async runOnce(opts: SkillBaselineObserverOptions): Promise<SkillBaselineObserverSummary> {
    const startedAt = Date.now();
    const window = opts.observationWindowDays ?? 14;
    const minRecall = opts.minRecallCount ?? 3;
    const minSignaled = opts.minSignaledRuns ?? 2;
    const minSuccess = opts.minSuccessRate ?? 0.6;
    const maxApproves = opts.maxApprovesPerRun ?? 20;

    const summary: SkillBaselineObserverSummary = {
      status: "completed",
      scanned: 0,
      approved: 0,
      notReady: 0,
      errors: 0,
      results: [],
      elapsedMs: 0,
    };

    const disabled = selfEvolveDisabledReason();
    if (disabled) {
      summary.status = "disabled";
      summary.reason = disabled;
      this.maybeEmit(opts, summary);
      summary.elapsedMs = Date.now() - startedAt;
      return summary;
    }

    try {
      const db = await getDb();
      // 候选：本 project 的 evolved + pending_review skill
      const candidates = await db
        .select({ id: agentSkill.id, name: agentSkill.name })
        .from(agentSkill)
        .where(
          and(
            eq(agentSkill.projectId, opts.projectId),
            eq(agentSkill.state, "pending_review"),
            eq(agentSkill.source, "evolved")
          )
        )
        .all();
      summary.scanned = candidates.length;
      if (candidates.length === 0) {
        this.maybeEmit(opts, summary);
        summary.elapsedMs = Date.now() - startedAt;
        return summary;
      }

      const cutoff = new Date(Date.now() - window * 86400_000).toISOString();
      const skillIds = candidates.map((c) => c.id);

      // bulk 拉 recall 次数（含 executed=false）
      const recallRows = await db
        .select({
          skillId: skillRecallLog.skillId,
          executed: skillRecallLog.executed,
        })
        .from(skillRecallLog)
        .where(
          and(
            inArray(skillRecallLog.skillId, skillIds),
            gte(skillRecallLog.createdAt, cutoff)
          )
        )
        .all();
      const recallBySkill = new Map<string, number>();
      for (const r of recallRows) {
        recallBySkill.set(r.skillId, (recallBySkill.get(r.skillId) ?? 0) + 1);
      }

      // bulk 拉 outcome
      const runRows = await db
        .select({
          skillId: agentSkillRun.skillId,
          outcome: agentSkillRun.outcome,
        })
        .from(agentSkillRun)
        .where(
          and(
            inArray(agentSkillRun.skillId, skillIds),
            gte(agentSkillRun.startedAt, cutoff),
            sql`${agentSkillRun.outcome} <> 'unknown'`
          )
        )
        .all();
      const outcomeBySkill = new Map<string, { success: number; fail: number; partial: number }>();
      for (const r of runRows) {
        const cur = outcomeBySkill.get(r.skillId) ?? { success: 0, fail: 0, partial: 0 };
        if (r.outcome === "success") cur.success += 1;
        else if (r.outcome === "fail") cur.fail += 1;
        else if (r.outcome === "partial") cur.partial += 1;
        outcomeBySkill.set(r.skillId, cur);
      }

      for (const cand of candidates) {
        if (summary.approved >= maxApproves) break;
        const recallCount = recallBySkill.get(cand.id) ?? 0;
        const oc = outcomeBySkill.get(cand.id) ?? { success: 0, fail: 0, partial: 0 };
        const signaled = oc.success + oc.fail + oc.partial;
        const successRate = signaled === 0 ? 0 : oc.success / signaled;

        const meetsRecall = recallCount >= minRecall;
        const meetsSignaled = signaled >= minSignaled;
        const meetsSuccess = successRate >= minSuccess;

        if (meetsRecall && meetsSignaled && meetsSuccess) {
          try {
            await approveSkillPromotion(cand.id, {
              actor: "skill_baseline_observer",
              description: `auto-approved (recall=${recallCount}/${minRecall}, signaled=${signaled}/${minSignaled}, successRate=${(successRate * 100).toFixed(0)}%≥${(minSuccess * 100).toFixed(0)}%)`,
            });
            summary.approved += 1;
            summary.results.push({
              skillId: cand.id,
              name: cand.name,
              action: "approved",
              recallCount,
              signaledRunCount: signaled,
              successCount: oc.success,
              failCount: oc.fail,
              successRate,
            });
          } catch (e) {
            summary.errors += 1;
            summary.results.push({
              skillId: cand.id,
              name: cand.name,
              action: "error",
              recallCount,
              signaledRunCount: signaled,
              successCount: oc.success,
              failCount: oc.fail,
              successRate,
              reason: e instanceof Error ? e.message : String(e),
            });
          }
        } else {
          const why: string[] = [];
          if (!meetsRecall) why.push(`recall=${recallCount}<${minRecall}`);
          if (!meetsSignaled) why.push(`signaled=${signaled}<${minSignaled}`);
          if (meetsSignaled && !meetsSuccess)
            why.push(`successRate=${(successRate * 100).toFixed(0)}%<${(minSuccess * 100).toFixed(0)}%`);
          summary.notReady += 1;
          summary.results.push({
            skillId: cand.id,
            name: cand.name,
            action: "not_ready",
            recallCount,
            signaledRunCount: signaled,
            successCount: oc.success,
            failCount: oc.fail,
            successRate,
            reason: why.join("; "),
          });
        }
      }
    } catch (e) {
      summary.status = "failed";
      summary.reason = e instanceof Error ? e.message : String(e);
    }

    summary.elapsedMs = Date.now() - startedAt;
    this.maybeEmit(opts, summary);
    void getSelfEvolveConfig; // 只为表明 config 已被显式读过（disabled gate 已经用过）
    return summary;
  }

  private maybeEmit(
    opts: SkillBaselineObserverOptions,
    summary: SkillBaselineObserverSummary
  ): void {
    if (opts.emitMetrics === false) return;
    try {
      this.bus.emit({
        type: "maintenance_run",
        kind: "skill_baseline_observer",
        actor: "skill_baseline_observer",
        summary: {
          status: summary.status,
          scanned: summary.scanned,
          approved: summary.approved,
          notReady: summary.notReady,
          errors: summary.errors,
          elapsedMs: summary.elapsedMs,
          ...(summary.reason ? { reason: summary.reason } : {}),
        },
      });
    } catch {
      /* metrics fail-safe */
    }
    void randomUUID;
  }
}
