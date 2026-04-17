import { eq, lt } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { sessionMemory } from "../../../db/sqlite/schema";
import type { SessionMemory } from "../../../types/entities";

const DEFAULT_TTL_HOURS = 24;

export class SessionMemoryStore {
  async upsert(
    workflowRunId: string,
    update: Partial<Omit<SessionMemory, "id" | "workflowRunId" | "updatedAt">>
  ): Promise<SessionMemory> {
    const db = await getDb();
    const now = new Date().toISOString();
    const ttlAt = new Date(
      Date.now() + DEFAULT_TTL_HOURS * 3_600_000
    ).toISOString();

    const existing = await this.findByWorkflowRun(workflowRunId);

    if (existing) {
      await db
        .update(sessionMemory)
        .set({ ...update, updatedAt: now })
        .where(eq(sessionMemory.workflowRunId, workflowRunId));
      return (await this.findByWorkflowRun(workflowRunId))!;
    }

    const id = crypto.randomUUID();
    await db.insert(sessionMemory).values({
      id,
      workflowRunId,
      summary: update.summary ?? "",
      stateJson: update.stateJson ?? {},
      asofTime: update.asofTime ?? now,
      ttlAt: update.ttlAt ?? ttlAt,
      updatedAt: now,
    });

    return (await this.findByWorkflowRun(workflowRunId))!;
  }

  async findByWorkflowRun(workflowRunId: string): Promise<SessionMemory | null> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(sessionMemory)
      .where(eq(sessionMemory.workflowRunId, workflowRunId))
      .limit(1);
    return (rows[0] as SessionMemory | undefined) ?? null;
  }

  async deleteExpired(): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db
      .delete(sessionMemory)
      .where(lt(sessionMemory.ttlAt, now));
  }
}

export const sessionStore = new SessionMemoryStore();
