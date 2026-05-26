/**
 * 监控 · Skills 维度聚合（窗口内）。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §4.1.4）：
 *   - 数据源：agent_skill_run（每次显式 skill 执行写一行）
 *   - 不依赖 LLM 自动归因，避免噪音；与团队拍板的「explicit-only」一致
 *   - 输出按 skill 聚合的成功 / 失败 / 平均分；前端用此构造表格 + 失败列表
 */
import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill, agentSkillRun, workflowRun } from "../../db/sqlite/schema";

export type SkillSummaryRow = {
  skillId: string;
  skillName: string;
  category: string;
  totalRuns: number;
  successCount: number;
  failCount: number;
  partialCount: number;
  unknownCount: number;
  successRate: number; // 0..1；totalRuns=0 时为 0
  avgScore: number | null;
  lastUsedAt: string | null;
};

export async function getSkillsSummary(input?: {
  /** 时间窗口（分钟），默认 1440=24h，最大 7 * 24 * 60 */
  windowMinutes?: number;
  sessionId?: string;
}): Promise<SkillSummaryRow[]> {
  const db = await getDb();
  const windowMinutes = clampInt(input?.windowMinutes ?? 24 * 60, 1, 7 * 24 * 60);
  const sinceIso = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
  const sessionId = input?.sessionId;

  // 注意：agent_skill_run 表的 workflowRunId 是 nullable（onDelete:set null）
  // sessionId 过滤需要 left join workflow_run；不过滤时省略 join 提升 1ms
  const baseQuery = db
    .select({
      skillId: agentSkillRun.skillId,
      skillName: agentSkill.name,
      category: agentSkill.category,
      outcome: agentSkillRun.outcome,
      score: agentSkillRun.score,
      startedAt: agentSkillRun.startedAt,
      workflowSessionId: workflowRun.sessionId,
    })
    .from(agentSkillRun)
    .innerJoin(agentSkill, eq(agentSkill.id, agentSkillRun.skillId))
    .leftJoin(workflowRun, eq(workflowRun.id, agentSkillRun.workflowRunId))
    .where(
      and(
        gte(agentSkillRun.startedAt, sinceIso),
        sessionId ? eq(workflowRun.sessionId, sessionId) : undefined
      )
    );

  const rows = await baseQuery;

  type Acc = Omit<SkillSummaryRow, "successRate"> & {
    scoreSum: number;
    scoreCount: number;
  };
  const grouped = new Map<string, Acc>();
  for (const r of rows) {
    let acc = grouped.get(r.skillId);
    if (!acc) {
      acc = {
        skillId: r.skillId,
        skillName: r.skillName,
        category: r.category ?? "general",
        totalRuns: 0,
        successCount: 0,
        failCount: 0,
        partialCount: 0,
        unknownCount: 0,
        avgScore: null,
        lastUsedAt: null,
        scoreSum: 0,
        scoreCount: 0,
      };
      grouped.set(r.skillId, acc);
    }
    acc.totalRuns += 1;
    if (r.outcome === "success") acc.successCount += 1;
    else if (r.outcome === "fail") acc.failCount += 1;
    else if (r.outcome === "partial") acc.partialCount += 1;
    else acc.unknownCount += 1;
    if (typeof r.score === "number") {
      acc.scoreSum += r.score;
      acc.scoreCount += 1;
    }
    if (!acc.lastUsedAt || r.startedAt > acc.lastUsedAt) {
      acc.lastUsedAt = r.startedAt;
    }
  }

  return [...grouped.values()]
    .map((acc): SkillSummaryRow => ({
      skillId: acc.skillId,
      skillName: acc.skillName,
      category: acc.category,
      totalRuns: acc.totalRuns,
      successCount: acc.successCount,
      failCount: acc.failCount,
      partialCount: acc.partialCount,
      unknownCount: acc.unknownCount,
      successRate: acc.totalRuns > 0 ? Number((acc.successCount / acc.totalRuns).toFixed(4)) : 0,
      avgScore:
        acc.scoreCount > 0 ? Number((acc.scoreSum / acc.scoreCount).toFixed(4)) : null,
      lastUsedAt: acc.lastUsedAt,
    }))
    .sort((a, b) => b.totalRuns - a.totalRuns);
}

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}
