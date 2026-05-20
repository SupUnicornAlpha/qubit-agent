import { mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

const tmpDir = `${process.cwd()}/.tmp-checkpoint-saver-test`;
process.env.QUBIT_DATA_DIR = tmpDir;

const { runMigrations } = await import("../../db/sqlite/migrate");
const { closeDb } = await import("../../db/sqlite/client");
const { getCheckpointSaver, SqliteCheckpointSaver } = await import("./sqlite-checkpoint-saver");

describe("SqliteCheckpointSaver", () => {
  beforeAll(async () => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    process.env.QUBIT_DATA_DIR = tmpDir;
    await runMigrations();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when no checkpoint exists", async () => {
    const saver = new SqliteCheckpointSaver();
    const tuple = await saver.getTuple({ configurable: { thread_id: "wf-empty" } });
    expect(tuple).toBeUndefined();
  });

  it("roundtrips put -> getTuple -> list", async () => {
    const saver = getCheckpointSaver();
    const ckpt = {
      v: 1,
      id: "ckpt-001",
      ts: new Date().toISOString(),
      channel_values: { state: { iteration: 2, observations: [{ k: "v" }] } },
      channel_versions: { state: 3 },
      versions_seen: {},
      pending_sends: [],
    };
    const meta = { source: "input", step: 2, writes: {}, parents: {} };

    const cfg = await saver.put(
      { configurable: { thread_id: "wf-1" } },
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      ckpt as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      meta as any
    );
    expect(cfg.configurable?.checkpoint_id).toBe("ckpt-001");

    const tuple = await saver.getTuple({ configurable: { thread_id: "wf-1" } });
    expect(tuple?.checkpoint.id).toBe("ckpt-001");
    // biome-ignore lint/suspicious/noExplicitAny: test access to dynamic field
    expect((tuple?.checkpoint.channel_values as any).state.iteration).toBe(2);

    const ids: string[] = [];
    for await (const t of saver.list({ configurable: { thread_id: "wf-1" } })) {
      ids.push(t.checkpoint.id);
    }
    expect(ids).toEqual(["ckpt-001"]);
  });

  it("persists pendingWrites and surfaces them on getTuple", async () => {
    const saver = getCheckpointSaver();
    const ckpt = {
      v: 1,
      id: "ckpt-002",
      ts: new Date().toISOString(),
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
      pending_sends: [],
    };
    await saver.put(
      { configurable: { thread_id: "wf-2" } },
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      ckpt as any,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      { source: "input", step: 0, writes: {}, parents: {} } as any
    );
    await saver.putWrites(
      { configurable: { thread_id: "wf-2", checkpoint_id: "ckpt-002" } },
      // biome-ignore lint/suspicious/noExplicitAny: PendingWrite tuple type narrowing
      [["state", { plannedAction: "tool_x" }] as any],
      "task-1"
    );

    const tuple = await saver.getTuple({ configurable: { thread_id: "wf-2" } });
    expect(tuple?.pendingWrites?.length).toBe(1);
    const pw = tuple?.pendingWrites?.[0];
    expect(pw?.[0]).toBe("task-1");
    expect(pw?.[1]).toBe("state");
  });

  it("deleteThread wipes both checkpoints and writes", async () => {
    const saver = getCheckpointSaver();
    await saver.deleteThread("wf-1");
    await saver.deleteThread("wf-2");
    expect(await saver.getTuple({ configurable: { thread_id: "wf-1" } })).toBeUndefined();
    expect(await saver.getTuple({ configurable: { thread_id: "wf-2" } })).toBeUndefined();
  });
});
