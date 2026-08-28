import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentScore } from "../../db/sqlite/schema";
import type { AgentScoreRecord } from "./contracts";
import { decodeScoreValue } from "./score-value";

export interface ListScoresQuery {
  workflowRunId?: string;
  sessionId?: string;
  name?: string;
  names?: string[];
  since?: string;
  limit?: number;
}

function toRecord(row: typeof agentScore.$inferSelect): AgentScoreRecord {
  return {
    id: row.id,
    name: row.name,
    value: decodeScoreValue({
      dataType: row.dataType,
      valueNumeric: row.valueNumeric,
      valueCategorical: row.valueCategorical,
      valueBoolean: row.valueBoolean,
      valueText: row.valueText,
    }),
    ...(row.comment ? { comment: row.comment } : {}),
    source: row.source,
    ...(row.evaluatorId ? { evaluatorId: row.evaluatorId } : {}),
    workflowRunId: row.workflowRunId,
    ...(row.observationId ? { observationId: row.observationId } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.evalRunId ? { evalRunId: row.evalRunId } : {}),
    ...(row.datasetItemId ? { datasetItemId: row.datasetItemId } : {}),
    ...(row.configFingerprint ? { configFingerprint: row.configFingerprint } : {}),
    createdAt: row.createdAt,
  };
}

export async function listScores(query: ListScoresQuery): Promise<AgentScoreRecord[]> {
  const db = await getDb();
  const conds = [];
  if (query.workflowRunId) conds.push(eq(agentScore.workflowRunId, query.workflowRunId));
  if (query.sessionId) conds.push(eq(agentScore.sessionId, query.sessionId));
  if (query.name) conds.push(eq(agentScore.name, query.name));
  if (query.names?.length) conds.push(inArray(agentScore.name, query.names));
  if (query.since) conds.push(gte(agentScore.createdAt, query.since));

  const limit = Math.max(1, Math.min(500, query.limit ?? 200));
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);

  const rows = where
    ? await db
        .select()
        .from(agentScore)
        .where(where)
        .orderBy(desc(agentScore.createdAt))
        .limit(limit)
    : await db.select().from(agentScore).orderBy(desc(agentScore.createdAt)).limit(limit);

  return rows.map(toRecord);
}

export async function summarizeScoresByName(
  names: string[],
  since?: string
): Promise<Array<{ name: string; count: number; avgNumeric: number | null }>> {
  const records = await listScores({
    ...(names.length ? { names } : {}),
    ...(since ? { since } : {}),
    limit: 500,
  });
  const buckets = new Map<string, { count: number; sum: number; numericCount: number }>();
  for (const record of records) {
    const bucket = buckets.get(record.name) ?? { count: 0, sum: 0, numericCount: 0 };
    bucket.count += 1;
    if (record.value.dataType === "NUMERIC" && typeof record.value.numeric === "number") {
      bucket.sum += record.value.numeric;
      bucket.numericCount += 1;
    }
    buckets.set(record.name, bucket);
  }
  return [...buckets.entries()].map(([name, bucket]) => ({
    name,
    count: bucket.count,
    avgNumeric: bucket.numericCount > 0 ? bucket.sum / bucket.numericCount : null,
  }));
}
