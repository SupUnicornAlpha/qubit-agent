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
 * 算法 v0（equal_weight_v0，默认）：
 *   - perSkillShare = pnlAttributed / max(1, K)，K = executed=true 的 skill_id 去重数
 *   - 没有任何 executed skill 的 workflow_run → 跳过（无归因目标）
 *   - 同 workflow 多次执行同 skill_id 的多条 skill_run → 都写 pnlDelta = perSkillShare（不再除 N，
 *     因为这是该 skill 当次贡献的"基准值"，多次调用每次都被认为同贡献）
 *
 * 算法 v1（recency_weighted_v1，W1 2026-06-10）：
 *   - 同 workflow 里被召回执行过的所有 skill_id 按 first-touch 时间排序（min(created_at)）
 *   - 越接近最终决策的 skill 权重越大：weight_i = lambda^(N - 1 - i)，i=0 最早，i=N-1 最晚
 *   - perSkillShare_i = pnlAttributed * weight_i / sum(weights)
 *   - 直觉：链路末端的 skill（如"组合策略输出"、"下单"）真正驱动 PnL；链路前端的（如"取数据"）
 *     是必要前置但不直接拿盈亏。lambda 默认 0.85 给中间值留位（不是 0.5 那么激进）
 *   - agent_pnl_attribution.perSkillShare 仍写"等权占位值"（pnl/N），具体每 skill 的份额进
 *     metadata_json.perSkillShareByIdJson；保持 schema 兼容，但不再"误导报表平均值"
 *   - 同 method alias：'time_decay_v1'（图里描述的叫法）→ 走相同算法
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

/**
 * v1 衰减系数：weight_i = lambda^(N-1-i)。
 *
 * - 0.85：3 个 skill 时权重 [0.72, 0.85, 1.00]，归一化后 [0.28, 0.33, 0.39]
 *   末位约比首位多 11pp，温和但有差异
 * - 0.5（不用，过激进）：3 个 skill 时 [0.25, 0.5, 1.0] → [0.14, 0.29, 0.57]，前端几乎不分
 * - 1.0：等同于 v0（全等权）
 */
const DEFAULT_RECENCY_DECAY_LAMBDA = 0.85;

/**
 * 判断 method 是否走 v1 recency-weighted 路径。
 * 'time_decay_v1' 是图描述的别名（用户沟通词汇），与 'recency_weighted_v1' 同义。
 */
function isRecencyWeightedMethod(method: string): boolean {
  return method === "recency_weighted_v1" || method === "time_decay_v1";
}

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
  /** 默认 'equal_weight_v0'；可选 'recency_weighted_v1' / 'time_decay_v1' 走 W1 衰减加权 */
  attributionMethod?: string;
  /**
   * v1 only：recency 衰减系数 lambda ∈ (0, 1]。默认 0.85。
   *  - 1.0 → 退化为 v0 等权（没意义）
   *  - 0.5 → 末位 skill 权重远大于首位（激进）
   *  - 0.85 → 默认温和值
   */
  recencyDecayLambda?: number;
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
    const lambda = (() => {
      const v = input.recencyDecayLambda;
      if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1) return v;
      return DEFAULT_RECENCY_DECAY_LAMBDA;
    })();
    const touchedSkills = new Set<string>();

    for (const item of input.items) {
      try {
        const r = await this.attributeOne(item, method, lambda, touchedSkills);
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
    recencyDecayLambda: number,
    touchedSkills: Set<string>
  ): Promise<{ skipped: boolean; skillRunsUpdated: number }> {
    /**
     * 1) 取该 workflow 召回执行过的 skill_id 去重 + first-touch 时间。
     * v0 路径只看 skill_id；v1 还要按 firstAt 排序做 recency 衰减。
     * 用 GROUP BY + MIN(created_at) 一次拿齐：同 skill_id 多次召回取最早一次代表"首次接触"时间。
     */
    const recallRows = await this.db
      .select({
        skillId: skillRecallLog.skillId,
        firstAt: sql<string>`MIN(${skillRecallLog.createdAt})`,
      })
      .from(skillRecallLog)
      .where(
        and(eq(skillRecallLog.workflowRunId, item.workflowRunId), eq(skillRecallLog.executed, true))
      )
      .groupBy(skillRecallLog.skillId)
      .all();
    /** 按 firstAt 升序：i=0 最早；i=N-1 最晚（最接近最终决策） */
    recallRows.sort((a, b) => (a.firstAt ?? "").localeCompare(b.firstAt ?? ""));
    const skillIds = recallRows.map((r) => r.skillId);
    if (skillIds.length === 0) {
      return { skipped: true, skillRunsUpdated: 0 };
    }

    /**
     * 算 perSkillShare：
     *   - v0：所有 skill 同值 = pnl / K
     *   - v1：按 weight_i = lambda^(N-1-i) 加权，归一化后乘 pnl
     */
    const N = skillIds.length;
    const isV1 = isRecencyWeightedMethod(attributionMethod);
    const perSkillShareById = new Map<string, number>();
    let perSkillShareScalar: number; // 写 agent_pnl_attribution.perSkillShare 用（real 字段）
    if (isV1) {
      const weights = skillIds.map((_, i) => Math.pow(recencyDecayLambda, N - 1 - i));
      const sumW = weights.reduce((a, b) => a + b, 0) || 1;
      skillIds.forEach((sid, i) => {
        perSkillShareById.set(sid, (item.pnlAttributed * weights[i]!) / sumW);
      });
      /** v1 主字段写"等权占位"，避免误导报表为某一 skill 的 share；具体值进 metadata_json */
      perSkillShareScalar = item.pnlAttributed / N;
    } else {
      const equal = item.pnlAttributed / N;
      perSkillShareScalar = equal;
      skillIds.forEach((sid) => perSkillShareById.set(sid, equal));
    }
    /** 兼容老变量名：v0 路径下 perSkillShare 与 perSkillShareScalar 一致 */
    const perSkillShare = perSkillShareScalar;

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

      /**
       * W1：v1 路径把每个 skill 的真实 share 写进 metadata_json，
       * 报表/UI 读 perSkillShareByIdJson 比读主字段更精确。
       */
      const metadataJson: Record<string, unknown> = { skill_count: skillIds.length };
      if (isV1) {
        metadataJson["recencyDecayLambda"] = recencyDecayLambda;
        metadataJson["skillIdsOrderedByFirstTouch"] = skillIds;
        metadataJson["perSkillShareByIdJson"] = Object.fromEntries(
          Array.from(perSkillShareById.entries()).map(([k, v]) => [k, round6(v)])
        );
      }
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
        metadataJson,
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
      // W1：从 perSkillShareById 拿对应 share；v0 路径下所有 skill 拿到同值，行为不变
      for (const skillId of skillIds) {
        const shareForSkill = perSkillShareById.get(skillId) ?? perSkillShare;
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
              pnlDelta: round6(shareForSkill),
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

  /**
   * Self-Evolving Agent P9：按 **agent definition** 维度查最近 N 天最赚钱的 top-K skill。
   *
   * 与 `listSkillRankings`（project 维度、读 30 天滚动 cache）不同：
   *   - 按 `agent_skill_run.definitionId` 精确归属（多 agent 共用同 project 时不串台）
   *   - 实时聚合（窗口可调，不用等 PnlAttributor 重算 cache）
   *   - 只看 pnlDelta IS NOT NULL 的 run；没归因到 PnL 的 run（如 P4b 前 / 无 PnL 上下文）天然过滤掉
   *
   * 用法：reason 节点注入"该 agent 最近 7d 最赚钱 top-3 skill"prompt 块。
   * 性能：依赖 `idx_agent_skill_run_definition` + `started_at` 二级索引；P9 期 < 10k run/agent 可接受。
   */
  async listSkillRankingsByDefinition(
    definitionId: string,
    options: { windowDays?: number; topK?: number; minSampleCount?: number } = {}
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
    const windowDays = options.windowDays ?? 7;
    const topK = options.topK ?? 3;
    const minSample = options.minSampleCount ?? 1;
    const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString();
    const rows = await this.db
      .select({
        skillId: agentSkillRun.skillId,
        pnlDelta: agentSkillRun.pnlDelta,
      })
      .from(agentSkillRun)
      .where(
        and(
          eq(agentSkillRun.definitionId, definitionId),
          gte(agentSkillRun.startedAt, cutoff),
          sql`${agentSkillRun.pnlDelta} IS NOT NULL`
        )
      )
      .all();
    if (rows.length === 0) return [];
    const agg = new Map<string, { pnlSum: number; winCount: number; loseCount: number; sampleCount: number }>();
    for (const r of rows) {
      if (r.pnlDelta == null) continue;
      const cur = agg.get(r.skillId) ?? { pnlSum: 0, winCount: 0, loseCount: 0, sampleCount: 0 };
      cur.pnlSum += r.pnlDelta;
      cur.sampleCount += 1;
      if (r.pnlDelta > 0) cur.winCount += 1;
      else if (r.pnlDelta < 0) cur.loseCount += 1;
      agg.set(r.skillId, cur);
    }
    const ids = Array.from(agg.keys());
    if (ids.length === 0) return [];
    const skillRows = await this.db
      .select({ id: agentSkill.id, name: agentSkill.name })
      .from(agentSkill)
      .where(inArray(agentSkill.id, ids))
      .all();
    const nameById = new Map(skillRows.map((s) => [s.id, s.name]));
    const out = ids
      .map((id) => {
        const a = agg.get(id)!;
        return {
          skillId: id,
          name: nameById.get(id) ?? "(unknown)",
          pnlSum: round6(a.pnlSum),
          winCount: a.winCount,
          loseCount: a.loseCount,
          sampleCount: a.sampleCount,
        };
      })
      .filter((r) => r.sampleCount >= minSample && nameById.has(r.skillId));
    out.sort((a, b) => b.pnlSum - a.pnlSum);
    return out.slice(0, topK);
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
