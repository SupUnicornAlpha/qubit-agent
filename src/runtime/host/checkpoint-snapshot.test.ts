/**
 * Host checkpoint row helpers — load / delete only (Phase B).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import { agentCheckpointSnapshot } from "../../db/sqlite/schema";
import {
  deleteCheckpointSnapshotsForWorkflow,
  loadLatestCheckpointSnapshot,
  loadLatestSnapshotByRunId,
} from "./checkpoint-snapshot";

async function insertLegacyRow(input: {
  workflowRunId: string;
  runId: string;
  stepIndex: number;
  phase: string;
  iteration: number;
}): Promise<void> {
  const db = await getDb();
  const sqlite = getSqliteForTesting();
  sqlite.exec("PRAGMA foreign_keys = OFF");
  await db.insert(agentCheckpointSnapshot).values({
    id: randomUUID(),
    workflowRunId: input.workflowRunId,
    agentInstanceId: "inst-test",
    runId: input.runId,
    stepIndex: input.stepIndex,
    phase: input.phase,
    iteration: input.iteration,
    snapshotJson: { legacy: true, iteration: input.iteration },
    stateHash: randomUUID().slice(0, 32),
  });
  sqlite.exec("PRAGMA foreign_keys = ON");
}

describe("host checkpoint-snapshot", () => {
  beforeAll(async () => {
    await getDb();
    await runMigrations();
  });

  afterAll(async () => {
    const db = await getDb();
    await db.delete(agentCheckpointSnapshot);
  });

  test("loadLatestCheckpointSnapshot returns newest row", async () => {
    const wf = randomUUID();
    const runA = randomUUID();
    const runB = randomUUID();
    await insertLegacyRow({
      workflowRunId: wf,
      runId: runA,
      stepIndex: 1,
      phase: "reason",
      iteration: 1,
    });
    await insertLegacyRow({
      workflowRunId: wf,
      runId: runB,
      stepIndex: 3,
      phase: "act",
      iteration: 2,
    });
    const loaded = await loadLatestCheckpointSnapshot(wf);
    expect(loaded?.runId).toBe(runB);
    expect(loaded?.stepIndex).toBe(3);
    expect(loaded?.phase).toBe("act");
  });

  test("loadLatestSnapshotByRunId isolates concurrent slots", async () => {
    const wf = randomUUID();
    const runA = randomUUID();
    const runB = randomUUID();
    await insertLegacyRow({
      workflowRunId: wf,
      runId: runA,
      stepIndex: 1,
      phase: "reason",
      iteration: 1,
    });
    await insertLegacyRow({
      workflowRunId: wf,
      runId: runB,
      stepIndex: 9,
      phase: "observe",
      iteration: 4,
    });
    const a = await loadLatestSnapshotByRunId(runA);
    const b = await loadLatestSnapshotByRunId(runB);
    expect(a?.iteration).toBe(1);
    expect(b?.iteration).toBe(4);
  });

  test("deleteCheckpointSnapshotsForWorkflow clears all rows", async () => {
    const wf = randomUUID();
    await insertLegacyRow({
      workflowRunId: wf,
      runId: randomUUID(),
      stepIndex: 1,
      phase: "reason",
      iteration: 0,
    });
    await insertLegacyRow({
      workflowRunId: wf,
      runId: randomUUID(),
      stepIndex: 2,
      phase: "act",
      iteration: 1,
    });
    const n = await deleteCheckpointSnapshotsForWorkflow(wf);
    expect(n).toBe(2);
    expect(await loadLatestCheckpointSnapshot(wf)).toBeNull();
  });
});
