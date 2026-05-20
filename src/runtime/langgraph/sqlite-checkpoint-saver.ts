import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  getCheckpointId,
} from "@langchain/langgraph-checkpoint";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { langgraphCheckpoint, langgraphCheckpointWrite, workflowRun } from "../../db/sqlite/schema";

/**
 * Bun:sqlite + Drizzle 后端的 LangGraph CheckpointSaver。
 *
 * 对应表：
 *   - `langgraph_checkpoint`        每个节点边界一行
 *   - `langgraph_checkpoint_write`  节点中断时未提交的 pendingWrites
 *
 * 序列化：调用方传入的 serde 返回 (type, Uint8Array)，本类把 Uint8Array 用 base64 存入 TEXT 字段。
 */
export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  private encode(value: Uint8Array): string {
    return Buffer.from(value).toString("base64");
  }

  private decode(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  private threadId(config: RunnableConfig): string {
    const t = config.configurable?.thread_id;
    if (typeof t !== "string" || t.length === 0) {
      throw new Error("[SqliteCheckpointSaver] missing thread_id in RunnableConfig.configurable");
    }
    return t;
  }

  private ns(config: RunnableConfig): string {
    const n = config.configurable?.checkpoint_ns;
    return typeof n === "string" ? n : "";
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const db = await getDb();
    const threadId = this.threadId(config);
    const ns = this.ns(config);
    const explicitCheckpointId = getCheckpointId(config);

    const rows = explicitCheckpointId
      ? await db
          .select()
          .from(langgraphCheckpoint)
          .where(
            and(
              eq(langgraphCheckpoint.threadId, threadId),
              eq(langgraphCheckpoint.checkpointNs, ns),
              eq(langgraphCheckpoint.checkpointId, explicitCheckpointId)
            )
          )
          .limit(1)
      : await db
          .select()
          .from(langgraphCheckpoint)
          .where(
            and(
              eq(langgraphCheckpoint.threadId, threadId),
              eq(langgraphCheckpoint.checkpointNs, ns)
            )
          )
          .orderBy(desc(langgraphCheckpoint.checkpointId))
          .limit(1);

    const row = rows[0];
    if (!row) return undefined;

    const pendingSends = await this.loadPendingSends(
      threadId,
      ns,
      row.parentCheckpointId ?? undefined
    );

    const checkpoint = {
      ...((await this.serde.loadsTyped(row.type, this.decode(row.checkpointBlob))) as Checkpoint),
      pending_sends: pendingSends,
    } satisfies Checkpoint;

    const metadata = (await this.serde.loadsTyped(
      row.type,
      this.decode(row.metadataBlob)
    )) as CheckpointMetadata;

    const writeRows = await db
      .select()
      .from(langgraphCheckpointWrite)
      .where(
        and(
          eq(langgraphCheckpointWrite.threadId, threadId),
          eq(langgraphCheckpointWrite.checkpointNs, ns),
          eq(langgraphCheckpointWrite.checkpointId, row.checkpointId)
        )
      )
      .orderBy(asc(langgraphCheckpointWrite.idx));

    const pendingWrites = await Promise.all(
      writeRows.map(async (w) => {
        const decoded = await this.serde.loadsTyped(w.type, this.decode(w.valueBlob));
        return [w.taskId, w.channel, decoded] as [string, string, unknown];
      })
    );

    const tuple: CheckpointTuple = {
      config: {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: row.checkpointId,
        },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (row.parentCheckpointId) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: row.parentCheckpointId,
        },
      };
    }
    return tuple;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    const db = await getDb();
    const threadId = this.threadId(config);
    const ns = this.ns(config);
    const before = options?.before?.configurable?.checkpoint_id;
    const limit = options?.limit;

    const whereExprs = [
      eq(langgraphCheckpoint.threadId, threadId),
      eq(langgraphCheckpoint.checkpointNs, ns),
    ];
    if (typeof before === "string") {
      whereExprs.push(lt(langgraphCheckpoint.checkpointId, before));
    }

    const baseQuery = db
      .select()
      .from(langgraphCheckpoint)
      .where(and(...whereExprs))
      .orderBy(desc(langgraphCheckpoint.checkpointId));
    const rows =
      typeof limit === "number" && limit > 0 ? await baseQuery.limit(limit) : await baseQuery;

    for (const row of rows) {
      const metadata = (await this.serde.loadsTyped(
        row.type,
        this.decode(row.metadataBlob)
      )) as CheckpointMetadata;
      if (options?.filter) {
        const ok = Object.entries(options.filter).every(
          ([k, v]) => (metadata as Record<string, unknown>)[k] === v
        );
        if (!ok) continue;
      }
      const tuple = await this.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: row.checkpointId,
        },
      });
      if (tuple) yield tuple;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    const db = await getDb();
    const threadId = this.threadId(config);
    const ns = this.ns(config);
    const { pending_sends: _omit, ...prepared } = copyCheckpoint(checkpoint);
    void _omit;
    const [type, ckptBytes] = this.serde.dumpsTyped(prepared);
    const [, metaBytes] = this.serde.dumpsTyped(metadata);
    const parentId = config.configurable?.checkpoint_id;

    await db
      .insert(langgraphCheckpoint)
      .values({
        threadId,
        checkpointNs: ns,
        checkpointId: checkpoint.id,
        parentCheckpointId: typeof parentId === "string" ? parentId : null,
        type,
        checkpointBlob: this.encode(ckptBytes),
        metadataBlob: this.encode(metaBytes),
      })
      .onConflictDoUpdate({
        target: [
          langgraphCheckpoint.threadId,
          langgraphCheckpoint.checkpointNs,
          langgraphCheckpoint.checkpointId,
        ],
        set: {
          parentCheckpointId: typeof parentId === "string" ? parentId : null,
          type,
          checkpointBlob: this.encode(ckptBytes),
          metadataBlob: this.encode(metaBytes),
        },
      });

    // 用于 sweep：把最近一次 checkpoint 记到 workflow_run 上（best-effort）
    try {
      await db
        .update(workflowRun)
        .set({
          langgraphThreadId: threadId,
          lastCheckpointId: checkpoint.id,
          lastCheckpointAt: new Date().toISOString(),
        })
        .where(eq(workflowRun.id, threadId));
    } catch {
      /* thread_id 可能不对应 workflow_run（如测试场景），忽略 */
    }

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: ns,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const db = await getDb();
    const threadId = this.threadId(config);
    const ns = this.ns(config);
    const checkpointId = config.configurable?.checkpoint_id;
    if (typeof checkpointId !== "string") {
      throw new Error(
        "[SqliteCheckpointSaver] putWrites: missing checkpoint_id in config.configurable"
      );
    }

    for (let i = 0; i < writes.length; i += 1) {
      const w = writes[i];
      if (!w) continue;
      const [channel, value] = w;
      const [type, bytes] = this.serde.dumpsTyped(value);
      const mappedIdx = WRITES_IDX_MAP[channel] ?? i;
      await db
        .insert(langgraphCheckpointWrite)
        .values({
          threadId,
          checkpointNs: ns,
          checkpointId,
          taskId,
          idx: mappedIdx,
          channel,
          type,
          valueBlob: this.encode(bytes),
        })
        .onConflictDoUpdate({
          target: [
            langgraphCheckpointWrite.threadId,
            langgraphCheckpointWrite.checkpointNs,
            langgraphCheckpointWrite.checkpointId,
            langgraphCheckpointWrite.taskId,
            langgraphCheckpointWrite.idx,
          ],
          set: { channel, type, valueBlob: this.encode(bytes) },
        });
    }
  }

  /** 删除某个 thread 的所有 checkpoint + writes（用于显式清理已完成的工作流）。 */
  async deleteThread(threadId: string, ns = ""): Promise<void> {
    const db = await getDb();
    await db
      .delete(langgraphCheckpointWrite)
      .where(
        and(
          eq(langgraphCheckpointWrite.threadId, threadId),
          eq(langgraphCheckpointWrite.checkpointNs, ns)
        )
      );
    await db
      .delete(langgraphCheckpoint)
      .where(
        and(eq(langgraphCheckpoint.threadId, threadId), eq(langgraphCheckpoint.checkpointNs, ns))
      );
  }

  /** 列出有 checkpoint 但 workflow_run 未结束的 thread_id，供启动 sweep 使用。 */
  async listResumableWorkflowIds(): Promise<string[]> {
    const db = await getDb();
    const rows = await db
      .select({ threadId: langgraphCheckpoint.threadId })
      .from(langgraphCheckpoint)
      .innerJoin(workflowRun, eq(workflowRun.id, langgraphCheckpoint.threadId))
      .where(
        and(
          eq(langgraphCheckpoint.checkpointNs, ""),
          sql`${workflowRun.endedAt} IS NULL`,
          sql`${workflowRun.status} IN ('pending','running')`
        )
      )
      .groupBy(langgraphCheckpoint.threadId);
    return rows.map((r) => r.threadId);
  }

  private async loadPendingSends(
    threadId: string,
    ns: string,
    parentCheckpointId?: string
  ): Promise<unknown[]> {
    if (!parentCheckpointId) return [];
    const db = await getDb();
    const rows = await db
      .select()
      .from(langgraphCheckpointWrite)
      .where(
        and(
          eq(langgraphCheckpointWrite.threadId, threadId),
          eq(langgraphCheckpointWrite.checkpointNs, ns),
          eq(langgraphCheckpointWrite.checkpointId, parentCheckpointId),
          eq(langgraphCheckpointWrite.channel, TASKS)
        )
      )
      .orderBy(asc(langgraphCheckpointWrite.idx));
    return Promise.all(rows.map((w) => this.serde.loadsTyped(w.type, this.decode(w.valueBlob))));
  }
}

let _saver: SqliteCheckpointSaver | null = null;

/** 进程级单例（与 getDb() 的单例对齐）。 */
export function getCheckpointSaver(): SqliteCheckpointSaver {
  if (!_saver) _saver = new SqliteCheckpointSaver();
  return _saver;
}
