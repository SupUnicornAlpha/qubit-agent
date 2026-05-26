/**
 * 监控 V2 P2 — Skill 召回日志写入器。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §4.1.4 / §6.8）：
 *   - reason 节点每次 `skillService.searchWithMeta(...)` 拿到候选 → 批量 insert 召回行
 *     （executed=false，score / rank 全填）
 *   - 后续若 `skillService.recordUsage(...)` 触发 → 把对应 workflowRunId + skillId 最近的
 *     召回行翻 executed=true（最多取最近 1 行）
 *
 * 失败兜底：所有 DB 操作 try/catch + console.warn，不阻塞主链路。
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { skillRecallLog } from "../../db/sqlite/schema";

export type RecordSkillRecallInput = {
  workflowRunId: string;
  /** 来源 step；reason 节点是 reasonStepId（如已建）；目前 reason 召回时 stepId 未知，传 null */
  agentStepId?: string | null;
  /** 触发召回的 agent definition；定位时用得到 */
  definitionId?: string | null;
  hits: Array<{ skillId: string; rank: number; score: number }>;
};

/**
 * 批量写入召回日志。一次 reason 调用产生一条 batch（topK 行）。
 * 任何错误仅 warn，不抛。
 */
export async function recordSkillRecall(input: RecordSkillRecallInput): Promise<void> {
  if (input.hits.length === 0) return;
  try {
    const db = await getDb();
    const rows = input.hits.map((h) => ({
      id: randomUUID(),
      workflowRunId: input.workflowRunId,
      agentStepId: input.agentStepId ?? null,
      definitionId: input.definitionId ?? null,
      skillId: h.skillId,
      recallRank: h.rank,
      score: h.score,
      executed: false,
    }));
    /**
     * Drizzle bulk insert：单事务比逐行写快约 10×。
     * 失败兜底：DB 异常（FK 失败 / sqlite busy）只会 warn，业务继续。
     */
    await db.insert(skillRecallLog).values(rows);
  } catch (err) {
    console.warn(
      `[skillRecallLog] batch insert failed (workflow=${input.workflowRunId} hits=${input.hits.length}): ${(err as Error).message}`
    );
  }
}

/**
 * 翻 executed=true：当 skill 真的被调用时（recordUsage 触发）调用一次。
 * 只翻该 (workflowRunId, skillId) 最近的 1 行召回日志（避免误翻历史召回）。
 */
export async function markSkillRecallExecuted(input: {
  workflowRunId: string;
  skillId: string;
}): Promise<void> {
  try {
    const db = await getDb();
    const latest = await db
      .select()
      .from(skillRecallLog)
      .where(
        and(
          eq(skillRecallLog.workflowRunId, input.workflowRunId),
          eq(skillRecallLog.skillId, input.skillId),
          eq(skillRecallLog.executed, false)
        )
      )
      .orderBy(desc(skillRecallLog.createdAt))
      .limit(1);
    if (!latest[0]) return;
    await db
      .update(skillRecallLog)
      .set({ executed: true })
      .where(eq(skillRecallLog.id, latest[0].id));
  } catch (err) {
    console.warn(
      `[skillRecallLog] mark executed failed (workflow=${input.workflowRunId} skill=${input.skillId}): ${(err as Error).message}`
    );
  }
}
