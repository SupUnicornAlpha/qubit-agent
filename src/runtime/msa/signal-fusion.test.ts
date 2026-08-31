import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "../../db/sqlite/schema";
import { fuseResearchSignals } from "./signal-fusion";

async function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  const db = drizzle(sqlite, { schema });
  await migrate(db, {
    migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), "../../db/sqlite/migrations"),
  });
  await db.insert(schema.workspace).values({ id: "ws-fusion", name: "fusion", owner: "test" });
  await db.insert(schema.project).values({
    id: "project-fusion",
    workspaceId: "ws-fusion",
    name: "fusion",
    marketScope: "US",
    status: "active",
  });
  await db.insert(schema.workflowRun).values({
    id: "workflow-fusion",
    projectId: "project-fusion",
    goal: "fusion",
    mode: "research",
    source: "test",
    status: "running",
  });
  return db;
}

describe("research signal fusion", () => {
  test("persists one immutable-snapshot audit record per input plus the fusion", async () => {
    const db = await makeDb();
    const result = await fuseResearchSignals(
      {
        workflowRunId: "workflow-fusion",
        snapshotId: "mkt_snapshot_fusion",
        signals: [
          {
            analystRole: "analyst_technical",
            ticker: "nvda",
            signal: "buy",
            confidence: 0.8,
            reasoning: "trend persists",
          },
          {
            analystRole: "analyst_fundamental",
            ticker: "NVDA",
            signal: "hold",
            confidence: 0.6,
            reasoning: "valuation is extended",
          },
        ],
        persistSignals: [
          {
            signal: {
              analystRole: "analyst_technical",
              ticker: "nvda",
              signal: "buy",
              confidence: 0.8,
              reasoning: "trend persists",
            },
          },
          {
            signal: {
              analystRole: "analyst_fundamental",
              ticker: "NVDA",
              signal: "hold",
              confidence: 0.6,
              reasoning: "valuation is extended",
            },
          },
        ],
      },
      db
    );
    expect(result.ticker).toBe("NVDA");
    const persisted = await db.select().from(schema.analystSignal);
    expect(persisted).toHaveLength(2);
    expect((persisted[0]?.dataSnapshotJson as Record<string, unknown>).snapshotId).toBe(
      "mkt_snapshot_fusion"
    );
    const fusion = await db.select().from(schema.signalFusionResult);
    expect(fusion).toHaveLength(1);
    expect((fusion[0]?.weightsJson as Record<string, unknown>).snapshotId).toBe(
      "mkt_snapshot_fusion"
    );
  });

  test("rejects malformed directions and cross-snapshot signal inputs", async () => {
    const db = await makeDb();
    await expect(
      fuseResearchSignals(
        {
          workflowRunId: "workflow-fusion",
          snapshotId: "snapshot-a",
          signals: [
            {
              analystRole: "technical",
              ticker: "AAPL",
              signal: "long" as never,
              confidence: 0.8,
              reasoning: "invalid enum",
            },
          ],
        },
        db
      )
    ).rejects.toThrow(/signal must be buy/);
    await expect(
      fuseResearchSignals(
        {
          workflowRunId: "workflow-fusion",
          snapshotId: "snapshot-a",
          signals: [
            {
              analystRole: "technical",
              ticker: "AAPL",
              signal: "buy",
              confidence: 0.8,
              reasoning: "mismatch",
              dataSnapshot: { snapshotId: "snapshot-b" },
            },
          ],
        },
        db
      )
    ).rejects.toThrow(/snapshotId must match/);
  });
});
