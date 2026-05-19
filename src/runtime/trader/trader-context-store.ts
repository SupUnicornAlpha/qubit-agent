import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import { traderContextMessage } from "../../db/sqlite/schema";

const MAX_MESSAGES = 100;
const MAX_TOTAL_CHARS = 20_000;
const KEEP_RECENT = 32;
const COMPRESS_BATCH = 48;

export type TraderContextRole = "user" | "system" | "driver" | "agent" | "compressed";

export interface AppendTraderContextInput {
  workflowRunId: string;
  sourceId?: string;
  role: TraderContextRole;
  kind: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}

export async function appendTraderContextMessage(
  input: AppendTraderContextInput,
  db?: DbClient
): Promise<{ id: string; appended: boolean; compressed: boolean }> {
  const client = db ?? (await getDb());
  if (input.sourceId) {
    const dup = await client
      .select({ id: traderContextMessage.id })
      .from(traderContextMessage)
      .where(
        and(
          eq(traderContextMessage.workflowRunId, input.workflowRunId),
          eq(traderContextMessage.sourceId, input.sourceId)
        )
      )
      .limit(1);
    if (dup[0]) {
      return { id: dup[0].id, appended: false, compressed: false };
    }
  }

  const id = randomUUID();
  await client.insert(traderContextMessage).values({
    id,
    workflowRunId: input.workflowRunId,
    sourceId: input.sourceId ?? null,
    role: input.role,
    kind: input.kind,
    title: input.title,
    body: input.body,
    payloadJson: input.payload ?? {},
  });

  const compressed = await maybeCompressTraderContext(input.workflowRunId, client);
  return { id, appended: true, compressed };
}

export async function listTraderContextMessages(
  workflowRunId: string,
  limit = 200,
  db?: DbClient
): Promise<Array<typeof traderContextMessage.$inferSelect>> {
  const client = db ?? (await getDb());
  return client
    .select()
    .from(traderContextMessage)
    .where(eq(traderContextMessage.workflowRunId, workflowRunId))
    .orderBy(asc(traderContextMessage.createdAt))
    .limit(limit);
}

async function contextStats(
  workflowRunId: string,
  db: DbClient
): Promise<{ total: number; chars: number }> {
  const rows = await db
    .select({
      total: count(),
      chars: sql<number>`coalesce(sum(length(${traderContextMessage.title}) + length(${traderContextMessage.body})), 0)`,
    })
    .from(traderContextMessage)
    .where(eq(traderContextMessage.workflowRunId, workflowRunId));
  return {
    total: Number(rows[0]?.total ?? 0),
    chars: Number(rows[0]?.chars ?? 0),
  };
}

function buildCompressionSummary(
  rows: Array<typeof traderContextMessage.$inferSelect>
): string {
  const lines = rows.map((r) => {
    const ts = r.createdAt.slice(0, 19);
    const head = r.title.trim() || r.kind;
    const snippet = r.body.trim().replace(/\s+/g, " ").slice(0, 120);
    return `- [${ts}] (${r.role}/${r.kind}) ${head}${snippet ? `: ${snippet}` : ""}`;
  });
  return lines.join("\n");
}

/** 将较早消息合并为一条 compressed 记录 */
export async function maybeCompressTraderContext(
  workflowRunId: string,
  db?: DbClient
): Promise<boolean> {
  const client = db ?? (await getDb());
  const stats = await contextStats(workflowRunId, client);
  if (stats.total <= MAX_MESSAGES && stats.chars <= MAX_TOTAL_CHARS) {
    return false;
  }

  const all = await client
    .select()
    .from(traderContextMessage)
    .where(eq(traderContextMessage.workflowRunId, workflowRunId))
    .orderBy(asc(traderContextMessage.createdAt));

  if (all.length <= KEEP_RECENT + 1) return false;

  const compressible = all.slice(0, Math.max(0, all.length - KEEP_RECENT));
  const toCompress = compressible.filter((r) => r.role !== "compressed").slice(-COMPRESS_BATCH);
  if (toCompress.length < 8) return false;

  const summaryBody = buildCompressionSummary(toCompress);
  const deleteIds = toCompress.map((r) => r.id);

  await client.delete(traderContextMessage).where(inArray(traderContextMessage.id, deleteIds));

  await client.insert(traderContextMessage).values({
    id: randomUUID(),
    workflowRunId,
    sourceId: `compressed-${Date.now()}`,
    role: "compressed",
    kind: "context_compress",
    title: `上下文压缩（${toCompress.length} 条）`,
    body: summaryBody,
    payloadJson: { mergedCount: toCompress.length, through: toCompress.at(-1)?.createdAt },
  });

  return true;
}

export async function getTraderContextTail(
  workflowRunId: string,
  limit = 80,
  db?: DbClient
): Promise<Array<typeof traderContextMessage.$inferSelect>> {
  const client = db ?? (await getDb());
  const rows = await client
    .select()
    .from(traderContextMessage)
    .where(eq(traderContextMessage.workflowRunId, workflowRunId))
    .orderBy(desc(traderContextMessage.createdAt))
    .limit(limit);
  return rows.reverse();
}
