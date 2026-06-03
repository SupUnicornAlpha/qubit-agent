/**
 * Self-Evolving Agent P4b — SkillAttributor（PnL → Agent/Skill 维度归因）。
 *
 * 责任：
 *   把 PnlAttributor 计算出的 (workflow_run, trading_day, pnlAttributed) 进一步分摊到
 *   该 workflow 召回执行过的所有 skill 上，写到 3 张表：
 *     1) agent_pnl_attribution — 一行 = (workflow_run, definition_id=NULL, as_of_date)
 *        全量保留：pnl_attributed + skill_ids_json + per_skill_share
 *     2) agent_skill_run.pnlDelta — 每个 skill 当 workflow 的 skill_run 行写 perSkillShare
 *     3) agent_skill.pnl_attribution_json — 30 天滚动汇总，每次 attribute 后覆盖
 *
 * 算法（v0 equal_weight_v0）：
 *   - perSkillShare = pnlAttributed / max(1, K)，K = executed=true 的 skill_id 去重数
 *   - 没有任何 executed skill 的 workflow_run → 跳过（无归因目标）
 *   - 同 workflow 多次执行同 skill_id 的多条 skill_run → 都写 pnlDelta = perSkillShare（不再除 N，
 *     因为这是该 skill 当次贡献的"基准值"，多次调用每次都被认为同贡献）
 *
 * upsert 策略：
 *   - agent_pnl_attribution：(workflow_run, definition_id=NULL, as_of_date) 唯一键。SQLite
 *     的 UNIQUE 在 NULL 上允许多行 —— 但我们一个 (workflow_run, day) 仅生成一行 NULL，
 *     所以靠先 select 再 insert/update 显式 upsert。
 *
 * 已知 caveat（P5 解决）：
 *   - skill.pnl_attribution_json 用 `LIKE '%"<skill_id>"%'` 扫 JSON，O(N) 全表扫。
 *     v0 30 天 N 通常 < 数千行可接受；P5 加 normalized 反向 (skill_id, attribution_id) 表。
 *   - definition_id=NULL：单 workflow 可能有跨 definition 的多个 skill；v0 不细分，
 *     P5+ 按 skill.definitionId 拆多行（unique 改成 (workflow_run, definition_id, day)）。
 */

import { randomUUID } from "node:crypto";
import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { runInTransaction } from "../../db/sqlite/client";
import {
  agentPnlAttribution,
  agentSkill,
  agentSkillRun,
  skillRecallLog,
} from "../../db/sqlite/schema";

const ATTRIBUTION_METHOD = "equal_weight_v0";
const ROLLING_WINDOW_DAYS = 30;

export interface SkillAttributorItem {
  /** 触发该 PnL 的 workflow_run */
  workflowRunId: string;
  /** market local trading day 'YYYY-MM-DD' */
  tradingDay: string;
  /** 该 workflow 当日的 PnL（已扣 fee） */
  pnlAttributed: number;
  /** 归因到的 strategy_runtime（agent_pnl_attribution.strategy_runtime_id 必填） */
  strategyRuntimeId: string;
}

export interface SkillAttributorInput {
  items: SkillAttributorItem[];
  /** 默认 'equal_weight_v0' */
  attributionMethod?: string;
}

export interface SkillAttributorSummary {
  itemsScanned: number;
  itemsSkippedNoSkill: number;
  attributionRowsUpserted: number;
  skillRunsUpdated: number;
  skillsRecomputed: number;
  errors: Array<{ workflowRunId: string; reason: string }>;
}

export class SkillAttributor {
  constructor(private readonly db: DbClient) {}

  async attribute(input: SkillAttributorInput): Promise<SkillAttributorSummary> {
    const summary: SkillAttributorSummary = {
      itemsScanned: input.items.length,
      itemsSkippedNoSkill: 0,
      attributionRowsUpserted: 0,
      skillRunsUpdated: 0,
      skillsRecomputed: 0,
      errors: [],
    };
    if (input.items.length === 0) return summary;

    const method = input.attributionMethod ?? ATTRIBUTION_METHOD;
    const touchedSkills = new Set<string>();

    for (const item of input.items) {
      try {
        const r = await this.attributeOne(item, method, touchedSkills);
        if (r.skipped) summary.itemsSkippedNoSkill += 1;
        else summary.attributionRowsUpserted += 1;
        summary.skillRunsUpdated += r.skillRunsUpdated;
      } catch (err) {
        summary.errors.push({
          workflowRunId: item.workflowRunId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 重算 touched skill 的 30 天滚动 pnl_attribution_json
    for (const skillId of touchedSkills) {
      try {
        await this.recomputeSkillRollup(skillId);
        summary.skillsRecomputed += 1;
      } catch (err) {
        summary.errors.push({
          workflowRunId: `<rollup:${skillId}>`,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return summary;
  }

  /** 处理单条 item。返回 skipped（没执行过任何 skill）/ skillRunsUpdated（更新的 skill_run 数） */
  private async attributeOne(
    item: SkillAttributorItem,
    attributionMethod: string,
    touchedSkills: Set<string>
  ): Promise<{ skipped: boolean; skillRunsUpdated: number }> {
    // 1) 取该 workflow 召回执行过的 skill_id 去重
    const recallRows = await this.db
      .select({ skillId: skillRecallLog.skillId })
      .from(skillRecallLog)
      .where(
        and(eq(skillRecallLog.workflowRunId, item.workflowRunId), eq(skillRecallLog.executed, true))
      )
      .all();
    const skillIds = Array.from(new Set(recallRows.map((r) => r.skillId)));
    if (skillIds.length === 0) {
      return { skipped: true, skillRunsUpdated: 0 };
    }
    const perSkillShare = item.pnlAttributed / skillIds.length;

    let skillRunsUpdated = 0;
    await runInTransaction(this.db, async () => {
      // 2) upsert agent_pnl_attribution
      const existing = await this.db
        .select({ id: agentPnlAttribution.id })
        .from(agentPnlAttribution)
        .where(
          and(
            eq(agentPnlAttribution.workflowRunId, item.workflowRunId),
            // definition_id IS NULL: 用 sql 显式（drizzle 的 eq null 不行）
            sql`${agentPnlAttribution.definitionId} IS NULL`,
            eq(agentPnlAttribution.asOfDate, item.tradingDay)
          )
        )
        .get();

      const values = {
        workflowRunId: item.workflowRunId,
        definitionId: null,
        strategyRuntimeId: item.strategyRuntimeId,
        asOfDate: item.tradingDay,
        pnlAttributed: round6(item.pnlAttributed),
        skillIdsJson: JSON.stringify(skillIds),
        perSkillShare: round6(perSkillShare),
        attributionMethod,
        attributionConfidence: 1.0,
        metadataJson: { skill_count: skillIds.length },
      };
      if (existing) {
        await this.db
          .update(agentPnlAttribution)
          .set({
            ...values,
            computedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          })
          .where(eq(agentPnlAttribution.id, existing.id))
          .run();
      } else {
        await this.db
          .insert(agentPnlAttribution)
          .values({
            id: `apa_${randomUUID()}`,
            ...values,
          })
          .run();
      }

      // 3) 写 agent_skill_run.pnlDelta：覆盖（不累加，确保幂等）
      for (const skillId of skillIds) {
        const runs = await this.db
          .select({ id: agentSkillRun.id })
          .from(agentSkillRun)
          .where(
            and(
              eq(agentSkillRun.workflowRunId, item.workflowRunId),
              eq(agentSkillRun.skillId, skillId)
            )
          )
          .all();
        for (const r of runs) {
          await this.db
            .update(agentSkillRun)
            .set({
              pnlDelta: round6(perSkillShare),
              attributionConfidence: 1.0,
            })
            .where(eq(agentSkillRun.id, r.id))
            .run();
          skillRunsUpdated += 1;
        }
        touchedSkills.add(skillId);
      }
    });

    return { skipped: false, skillRunsUpdated };
  }

  /**
   * 重算 skill 的 30 天滚动 PnL 汇总：
   *   - windowDays = 30
   *   - pnlSum = SUM(per_skill_share) over agent_pnl_attribution
   *             WHERE skill_ids_json contains skill_id AND as_of_date >= today-30
   *   - winCount = COUNT(per_skill_share > 0)
   *   - loseCount = COUNT(per_skill_share < 0)
   *
   * v0 用 LIKE '%"<skill_id>"%' 扫；30 天 N 不大可接受。
   */
  private async recomputeSkillRollup(skillId: string): Promise<void> {
    const cutoff = isoDaysAgo(ROLLING_WINDOW_DAYS);
    const rows = await this.db
      .select({
        perSkillShare: agentPnlAttribution.perSkillShare,
      })
      .from(agentPnlAttribution)
      .where(
        and(
          like(agentPnlAttribution.skillIdsJson, `%"${skillId}"%`),
          gte(agentPnlAttribution.asOfDate, cutoff)
        )
      )
      .all();
    let pnlSum = 0;
    let winCount = 0;
    let loseCount = 0;
    for (const r of rows) {
      pnlSum += r.perSkillShare;
      if (r.perSkillShare > 0) winCount += 1;
      else if (r.perSkillShare < 0) loseCount += 1;
    }
    const payload = {
      windowDays: ROLLING_WINDOW_DAYS,
      pnlSum: round6(pnlSum),
      winCount,
      loseCount,
      sampleCount: rows.length,
      lastUpdatedAt: new Date().toISOString(),
    };
    await this.db
      .update(agentSkill)
      .set({ pnlAttributionJson: JSON.stringify(payload) })
      .where(eq(agentSkill.id, skillId))
      .run();
  }

  // ───────────────────────── reader helpers（给 P4b-10 后端接口用） ─────────────────────────

  /** 列出某 strategy_runtime 在 [from, to] 内的归因汇总（workflow 维度展开）。 */
  async listAttributionsByRuntime(
    runtimeId: string,
    fromDay: string,
    toDay: string
  ): Promise<
    Array<{
      workflowRunId: string;
      asOfDate: string;
      pnlAttributed: number;
      perSkillShare: number;
      skillIds: string[];
    }>
  > {
    const rows = await this.db
      .select({
        workflowRunId: agentPnlAttribution.workflowRunId,
        asOfDate: agentPnlAttribution.asOfDate,
        pnlAttributed: agentPnlAttribution.pnlAttributed,
        perSkillShare: agentPnlAttribution.perSkillShare,
        skillIdsJson: agentPnlAttribution.skillIdsJson,
      })
      .from(agentPnlAttribution)
      .where(
        and(
          eq(agentPnlAttribution.strategyRuntimeId, runtimeId),
          gte(agentPnlAttribution.asOfDate, fromDay),
          // toDay 含端：lte
          sql`${agentPnlAttribution.asOfDate} <= ${toDay}`
        )
      )
      .all();
    return rows.map((r) => ({
      workflowRunId: r.workflowRunId,
      asOfDate: r.asOfDate,
      pnlAttributed: r.pnlAttributed,
      perSkillShare: r.perSkillShare,
      skillIds: parseSkillIds(r.skillIdsJson),
    }));
  }

  /** 列出当前 project 内所有 skill 的滚动 PnL 排行（按 pnlSum desc）。 */
  async listSkillRankings(
    projectId: string,
    limit = 50
  ): Promise<
    Array<{
      skillId: string;
      name: string;
      pnlSum: number;
      winCount: number;
      loseCount: number;
      sampleCount: number;
    }>
  > {
    const rows = await this.db
      .select({
        id: agentSkill.id,
        name: agentSkill.name,
        pnlAttributionJson: agentSkill.pnlAttributionJson,
      })
      .from(agentSkill)
      .where(eq(agentSkill.projectId, projectId))
      .all();
    const out = rows
      .map((r) => {
        const j = parseRollup(r.pnlAttributionJson);
        return {
          skillId: r.id,
          name: r.name,
          pnlSum: j.pnlSum,
          winCount: j.winCount,
          loseCount: j.loseCount,
          sampleCount: j.sampleCount,
        };
      })
      .filter((r) => r.sampleCount > 0);
    out.sort((a, b) => b.pnlSum - a.pnlSum);
    return out.slice(0, limit);
  }

  /** Bulk reader：一组 (workflow, skill) 的 pnl_delta 直读，避免 N+1。 */
  async getPnlDeltaForRuns(
    pairs: Array<{ workflowRunId: string; skillId: string }>
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (pairs.length === 0) return out;
    const workflowIds = Array.from(new Set(pairs.map((p) => p.workflowRunId)));
    const skillIds = Array.from(new Set(pairs.map((p) => p.skillId)));
    const rows = await this.db
      .select({
        id: agentSkillRun.id,
        workflowRunId: agentSkillRun.workflowRunId,
        skillId: agentSkillRun.skillId,
        pnlDelta: agentSkillRun.pnlDelta,
      })
      .from(agentSkillRun)
      .where(
        and(
          inArray(agentSkillRun.workflowRunId, workflowIds),
          inArray(agentSkillRun.skillId, skillIds)
        )
      )
      .all();
    for (const r of rows) {
      if (r.pnlDelta === null) continue;
      out.set(`${r.workflowRunId}|${r.skillId}`, r.pnlDelta);
    }
    return out;
  }
}

export function createSkillAttributor(db: DbClient): SkillAttributor {
  return new SkillAttributor(db);
}

// ───────────────────────── helpers ─────────────────────────

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

function parseSkillIds(json: string): string[] {
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? (arr.filter((x) => typeof x === "string") as string[]) : [];
  } catch {
    return [];
  }
}

function parseRollup(json: string): {
  pnlSum: number;
  winCount: number;
  loseCount: number;
  sampleCount: number;
} {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    return {
      pnlSum: Number(obj.pnlSum ?? 0),
      winCount: Number(obj.winCount ?? 0),
      loseCount: Number(obj.loseCount ?? 0),
      sampleCount: Number(obj.sampleCount ?? 0),
    };
  } catch {
    return { pnlSum: 0, winCount: 0, loseCount: 0, sampleCount: 0 };
  }
}
