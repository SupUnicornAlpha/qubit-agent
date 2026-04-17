import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { midtermMemory } from "../../../db/sqlite/schema";
import type { MidtermMemory, MidtermMemoryType } from "../../../types/entities";

export interface MidtermQueryParams {
  projectId: string;
  memoryType?: MidtermMemoryType;
  windowStart?: string;
  windowEnd?: string;
  minScore?: number;
  limit?: number;
}

export class MidtermMemoryStore {
  async insert(
    entry: Omit<MidtermMemory, "id" | "updatedAt">
  ): Promise<MidtermMemory> {
    const db = await getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.insert(midtermMemory).values({
      id,
      ...entry,
      updatedAt: now,
    });

    return { id, ...entry, updatedAt: now };
  }

  async query(params: MidtermQueryParams): Promise<MidtermMemory[]> {
    const db = await getDb();
    const conditions = [eq(midtermMemory.projectId, params.projectId)];

    if (params.memoryType) {
      conditions.push(eq(midtermMemory.memoryType, params.memoryType));
    }
    if (params.windowStart) {
      conditions.push(gte(midtermMemory.timeWindowEnd, params.windowStart));
    }
    if (params.windowEnd) {
      conditions.push(lte(midtermMemory.timeWindowStart, params.windowEnd));
    }

    const rows = await db
      .select()
      .from(midtermMemory)
      .where(and(...conditions))
      .limit(params.limit ?? 50);

    return rows as MidtermMemory[];
  }

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.delete(midtermMemory).where(eq(midtermMemory.id, id));
  }
}

export const midtermStore = new MidtermMemoryStore();
