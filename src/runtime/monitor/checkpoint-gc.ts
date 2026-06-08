/**
 * checkpoint-gc.ts — B+ Phase T1.4
 *
 * 周期 GC：删除 langgraph_checkpoint / langgraph_checkpoint_write 中"孤儿" 行。
 *
 * 关联模型：
 *   - thread_id 格式：`{workflow_run_id}:{role}:{def_id}`，前 36 字符是 workflow_run.id
 *   - 历史无 FK + 无 cascade，workflow_run 被删除后这些 ckpt blob 全部成孤儿
 *
 * 触发：monitor-aggregator-worker.tick() stage 5（每 5 分钟一次）
 *
 * 设计：
 *   - 用 NOT EXISTS subquery 而非 NOT IN，避免 workflow_run 表巨大时性能差
 *   - 写 + read 分两个 statement（先 count 再 delete），便于返回准确 deleted 数
 *   - 不抛错；catch 后返回 error 字段供调用方决定告警
 */
import { sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";

export type PurgeOrphanCheckpointsResult = {
  checkpointDeleted: number;
  checkpointWriteDeleted: number;
  error?: string;
};

export async function purgeOrphanCheckpoints(): Promise<PurgeOrphanCheckpointsResult> {
  const db = await getDb();
  try {
    /**
     * SQL 解释：
     *   - substr(thread_id, 1, 36) 取出 thread_id 的前 36 字符（UUID 长度）
     *   - 若该 substring 不在 workflow_run.id 中 → 整行删除
     *   - NOT EXISTS + 子查询：让 SQLite 用 PK 索引 lookup，比 NOT IN 稳健
     */
    const delCkpt = db.run(sql`
      DELETE FROM langgraph_checkpoint
      WHERE NOT EXISTS (
        SELECT 1 FROM workflow_run wr
        WHERE wr.id = substr(langgraph_checkpoint.thread_id, 1, 36)
      )
    `);
    const delWrite = db.run(sql`
      DELETE FROM langgraph_checkpoint_write
      WHERE NOT EXISTS (
        SELECT 1 FROM workflow_run wr
        WHERE wr.id = substr(langgraph_checkpoint_write.thread_id, 1, 36)
      )
    `);

    const [ckpt, write] = await Promise.all([delCkpt, delWrite]);

    /**
     * drizzle-orm 的 run() 返回 SQLiteRunResult，{ changes: number, lastInsertRowid }
     * 不同 driver 实现可能不一样；保守 fallback 用 .changes 或 0
     */
    const ckptChanges = (ckpt as unknown as { changes?: number })?.changes ?? 0;
    const writeChanges = (write as unknown as { changes?: number })?.changes ?? 0;
    return {
      checkpointDeleted: ckptChanges,
      checkpointWriteDeleted: writeChanges,
    };
  } catch (e) {
    return {
      checkpointDeleted: 0,
      checkpointWriteDeleted: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
