/**
 * checkpoint-gc.test.ts — B+ Phase T1.4
 *
 * 背景：langgraph_checkpoint / langgraph_checkpoint_write 表通过 thread_id 关联
 * workflow_run（thread_id 格式 `{workflow_run_id}:{role}:{def_id}`），但没有 FK
 * 约束 + 没有 cascade。workflow_run 被删后，对应 thread 的 ckpt blob 全部成孤儿。
 *
 * 实测一次清理释放 10.89 GB（4534 行 ckpt + 8340 行 write 中 87% 是孤儿）。
 *
 * 修复：monitor worker 周期调 `purgeOrphanCheckpoints()`，删除 thread_id 前 36
 * 字符不存在于 workflow_run.id 的行，并返回删除统计供告警。
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { purgeOrphanCheckpoints } from "../checkpoint-gc";
import { runMigrations } from "../../../db/sqlite/migrate";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";

const NOW = "2026-06-05T00:00:00.000Z";
let workspaceId: string;
let projectId: string;
let validWfId: string;

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  workspaceId = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "ckpt_gc_ws",
    owner: "test",
    createdAt: NOW,
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "ckpt_gc_proj",
    marketScope: "CN-A",
    createdAt: NOW,
  });
});

beforeEach(async () => {
  /** 每个 test 用唯一 prefix 避免互相干扰；先建一个真实 workflow_run 当"保留"参照 */
  const db = await getDb();
  validWfId = randomUUID();
  await db.insert(schema.workflowRun).values({
    id: validWfId,
    projectId,
    mode: "research",
    goal: "ckpt_gc_test",
    status: "running",
    createdAt: NOW,
  });
});

describe("purgeOrphanCheckpoints", () => {
  test("孤儿 thread（thread_id 前 36 字符不在 workflow_run.id 中）→ 被删除", async () => {
    const db = await getDb();
    const orphanWfPrefix = randomUUID();
    await db.insert(schema.langgraphCheckpoint).values({
      threadId: `${orphanWfPrefix}:role:def-x`,
      checkpointNs: "",
      checkpointId: "ckpt-1",
      type: "msgpack",
      checkpointBlob: "BLOB-1",
      metadataBlob: "{}",
      createdAt: NOW,
    });
    await db.insert(schema.langgraphCheckpointWrite).values({
      threadId: `${orphanWfPrefix}:role:def-x`,
      checkpointNs: "",
      checkpointId: "ckpt-1",
      taskId: "task-1",
      idx: 0,
      channel: "messages",
      type: "msgpack",
      valueBlob: "VAL-1",
      createdAt: NOW,
    });

    const beforeCkpt = await db
      .select({ c: sql<number>`COUNT(*)` })
      .from(schema.langgraphCheckpoint)
      .where(like(schema.langgraphCheckpoint.threadId, `${orphanWfPrefix}%`));
    expect(beforeCkpt[0]?.c).toBe(1);

    const result = await purgeOrphanCheckpoints();
    expect(result.checkpointDeleted).toBeGreaterThanOrEqual(1);
    expect(result.checkpointWriteDeleted).toBeGreaterThanOrEqual(1);

    const afterCkpt = await db
      .select({ c: sql<number>`COUNT(*)` })
      .from(schema.langgraphCheckpoint)
      .where(like(schema.langgraphCheckpoint.threadId, `${orphanWfPrefix}%`));
    expect(afterCkpt[0]?.c).toBe(0);

    const afterWrite = await db
      .select({ c: sql<number>`COUNT(*)` })
      .from(schema.langgraphCheckpointWrite)
      .where(like(schema.langgraphCheckpointWrite.threadId, `${orphanWfPrefix}%`));
    expect(afterWrite[0]?.c).toBe(0);
  });

  test("属于现有 workflow_run 的 thread → 保留（不被误删）", async () => {
    const db = await getDb();
    /** 用 validWfId（真实 workflow_run）作为 thread 前缀 */
    await db.insert(schema.langgraphCheckpoint).values({
      threadId: `${validWfId}:analyst_fundamental:def-x`,
      checkpointNs: "",
      checkpointId: "ckpt-keep",
      type: "msgpack",
      checkpointBlob: "BLOB-KEEP",
      metadataBlob: "{}",
      createdAt: NOW,
    });

    await purgeOrphanCheckpoints();

    const remaining = await db
      .select({ c: sql<number>`COUNT(*)` })
      .from(schema.langgraphCheckpoint)
      .where(eq(schema.langgraphCheckpoint.threadId, `${validWfId}:analyst_fundamental:def-x`));
    expect(remaining[0]?.c).toBe(1);
  });

  test("混合孤儿 + 保留 → 只删孤儿", async () => {
    const db = await getDb();
    const orphan1 = randomUUID();
    const orphan2 = randomUUID();
    await db.insert(schema.langgraphCheckpoint).values([
      {
        threadId: `${orphan1}:r1:d1`,
        checkpointNs: "",
        checkpointId: "c1",
        type: "msgpack",
        checkpointBlob: "B1",
        metadataBlob: "{}",
        createdAt: NOW,
      },
      {
        threadId: `${orphan2}:r2:d2`,
        checkpointNs: "",
        checkpointId: "c2",
        type: "msgpack",
        checkpointBlob: "B2",
        metadataBlob: "{}",
        createdAt: NOW,
      },
      {
        threadId: `${validWfId}:r3:d3`,
        checkpointNs: "",
        checkpointId: "c3",
        type: "msgpack",
        checkpointBlob: "B3",
        metadataBlob: "{}",
        createdAt: NOW,
      },
    ]);

    const result = await purgeOrphanCheckpoints();
    expect(result.checkpointDeleted).toBeGreaterThanOrEqual(2);

    const validRemain = await db
      .select({ c: sql<number>`COUNT(*)` })
      .from(schema.langgraphCheckpoint)
      .where(eq(schema.langgraphCheckpoint.threadId, `${validWfId}:r3:d3`));
    expect(validRemain[0]?.c).toBe(1);
  });

  test("无任何孤儿 → 返回 0", async () => {
    const result = await purgeOrphanCheckpoints();
    /** 不抛错；deleted 数字 >= 0（环境里可能有其它已存在数据，关注重复跑不再删） */
    expect(result.checkpointDeleted).toBeGreaterThanOrEqual(0);
    const result2 = await purgeOrphanCheckpoints();
    expect(result2.checkpointDeleted).toBe(0);
    expect(result2.checkpointWriteDeleted).toBe(0);
  });
});
