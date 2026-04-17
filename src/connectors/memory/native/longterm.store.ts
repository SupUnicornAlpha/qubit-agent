import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { longtermMemory } from "../../../db/sqlite/schema";
import {
  LANCE_TABLES,
  openOrCreateTable,
  vectorSearch,
} from "../../../db/lancedb/client";
import type {
  LongtermMemory,
  LongtermMemoryType,
  LongtermScope,
} from "../../../types/entities";

export interface LongtermQueryParams {
  scope?: LongtermScope;
  scopeId?: string;
  memoryType?: LongtermMemoryType;
  validAsOf?: string;
  limit?: number;
}

export interface LongtermSemanticSearchParams {
  queryVector: number[];
  scope?: LongtermScope;
  scopeId?: string;
  topK?: number;
  filter?: string;
}

export class LongtermMemoryStore {
  async insert(
    entry: Omit<LongtermMemory, "id" | "updatedAt">
  ): Promise<LongtermMemory> {
    const db = await getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.insert(longtermMemory).values({
      id,
      ...entry,
      updatedAt: now,
    });

    return { id, ...entry, updatedAt: now };
  }

  async query(params: LongtermQueryParams): Promise<LongtermMemory[]> {
    const db = await getDb();
    const conditions: ReturnType<typeof eq>[] = [];

    if (params.scope) conditions.push(eq(longtermMemory.scope, params.scope));
    if (params.scopeId) conditions.push(eq(longtermMemory.scopeId, params.scopeId));
    if (params.memoryType) conditions.push(eq(longtermMemory.memoryType, params.memoryType));

    const rows = await db
      .select()
      .from(longtermMemory)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .limit(params.limit ?? 50);

    return rows as LongtermMemory[];
  }

  /**
   * Semantic vector search via LanceDB.
   * Requires that embedding vectors have been written to LanceDB beforehand.
   */
  async semanticSearch(params: LongtermSemanticSearchParams): Promise<LongtermMemory[]> {
    const hits = await vectorSearch(
      LANCE_TABLES.LONGTERM_MEMORY,
      params.queryVector,
      params.topK ?? 10,
      params.filter
    );

    const ids = hits.map((h) => String(h["longtermMemoryId"])).filter(Boolean);
    if (ids.length === 0) return [];

    const db = await getDb();
    const rows = await db
      .select()
      .from(longtermMemory)
      .where(eq(longtermMemory.id, ids[0]!));

    return rows as LongtermMemory[];
  }

  async upsertEmbedding(
    longtermMemoryId: string,
    vector: number[],
    text: string,
    meta: Omit<LongtermMemory, "id" | "updatedAt" | "contentJson" | "embeddingRef" | "artifactUri" | "validTo">
  ): Promise<void> {
    const record = {
      id: crypto.randomUUID(),
      longtermMemoryId,
      vector,
      text,
      memoryType: meta.memoryType,
      scope: meta.scope,
      scopeId: meta.scopeId,
      asofTime: meta.asofTime,
      createdAt: new Date().toISOString(),
    };

    const table = await openOrCreateTable(LANCE_TABLES.LONGTERM_MEMORY, record);
    await table.add([record]);
  }

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.delete(longtermMemory).where(eq(longtermMemory.id, id));
  }
}

export const longtermStore = new LongtermMemoryStore();
