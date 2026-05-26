/**
 * 监控 · Skill 召回事件聚合（窗口内）。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §6.4）：
 *   - 数据源：skill_recall_log（reason 节点每次 skill 召回都写 topK 行）
 *   - 关键指标：召回次数 / 执行次数 / 命中率（executed/recalled）
 *   - 用途：评估 skill 召回质量 + 与显式 agent_skill_run 对比
 *
 * P2-H：表已有打点（reason.ts + skill-service.markSkillRecallExecuted），但此前
 *       监控 routes 没有暴露聚合查询；本服务把这一公里补齐。
 */
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill, skillRecallLog } from "../../db/sqlite/schema";

export type SkillRecallSummaryRow = {
  skillId: string;
  skillName: string;
  category: string;
  /** 召回次数（log 行数） */
  recalledCount: number;
  /** 召回后实际执行次数（executed=true 的 log 行数） */
  executedCount: number;
  /** 命中率 = executedCount / recalledCount（0..1） */
  hitRate: number;
  /** 召回时的平均分（vector similarity 等） */
  avgScore: number | null;
  /** 平均召回排名（rank 越小越靠前） */
  avgRecallRank: number | null;
  lastRecalledAt: string | null;
};

export async function getSkillRecallSummary(input?: {
  /** 时间窗口（分钟），默认 1440=24h，最大 7d */
  windowMinutes?: number;
  /** 按 definitionId 过滤；空 = 全 agent */
  definitionId?: string;
}): Promise<SkillRecallSummaryRow[]> {
  const db = await getDb();
  const windowMinutes = clampInt(input?.windowMinutes ?? 24 * 60, 1, 7 * 24 * 60);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const whereExpr = input?.definitionId
    ? and(
        gte(skillRecallLog.createdAt, sinceIso),
        eq(skillRecallLog.definitionId, input.definitionId),
      )
    : gte(skillRecallLog.createdAt, sinceIso);

  const rows = await db
    .select({
      skillId: skillRecallLog.skillId,
      skillName: agentSkill.name,
      category: agentSkill.category,
      score: skillRecallLog.score,
      recallRank: skillRecallLog.recallRank,
      executed: skillRecallLog.executed,
      createdAt: skillRecallLog.createdAt,
    })
    .from(skillRecallLog)
    .innerJoin(agentSkill, eq(agentSkill.id, skillRecallLog.skillId))
    .where(whereExpr)
    .limit(50_000);

  const grouped = new Map<
    string,
    SkillRecallSummaryRow & { scoreSum: number; scoreCount: number; rankSum: number; rankCount: number }
  >();
  for (const r of rows) {
    let g = grouped.get(r.skillId);
    if (!g) {
      g = {
        skillId: r.skillId,
        skillName: r.skillName ?? "(unknown)",
        category: r.category ?? "",
        recalledCount: 0,
        executedCount: 0,
        hitRate: 0,
        avgScore: null,
        avgRecallRank: null,
        lastRecalledAt: null,
        scoreSum: 0,
        scoreCount: 0,
        rankSum: 0,
        rankCount: 0,
      };
      grouped.set(r.skillId, g);
    }
    g.recalledCount += 1;
    if (r.executed) g.executedCount += 1;
    if (typeof r.score === "number" && Number.isFinite(r.score)) {
      g.scoreSum += r.score;
      g.scoreCount += 1;
    }
    if (typeof r.recallRank === "number" && Number.isFinite(r.recallRank)) {
      g.rankSum += r.recallRank;
      g.rankCount += 1;
    }
    if (g.lastRecalledAt === null || r.createdAt > g.lastRecalledAt) {
      g.lastRecalledAt = r.createdAt;
    }
  }

  return Array.from(grouped.values())
    .map(({ scoreSum, scoreCount, rankSum, rankCount, ...rest }) => ({
      ...rest,
      hitRate: rest.recalledCount === 0 ? 0 : rest.executedCount / rest.recalledCount,
      avgScore: scoreCount === 0 ? null : scoreSum / scoreCount,
      avgRecallRank: rankCount === 0 ? null : rankSum / rankCount,
    }))
    .sort((a, b) => b.recalledCount - a.recalledCount);
}

function clampInt(v: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? Math.round(v) : min;
  return Math.max(min, Math.min(max, n));
}
