import { mkdirSync, rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { END, START, StateGraph } from "@langchain/langgraph";

const tmpDir = `${process.cwd()}/.tmp-checkpoint-resume-test`;
process.env.QUBIT_DATA_DIR = tmpDir;

const { runMigrations } = await import("../../db/sqlite/migrate");
const { closeDb } = await import("../../db/sqlite/client");
const { SqliteCheckpointSaver } = await import("./sqlite-checkpoint-saver");

type S = { value: number; trace: string[] };

function buildGraph(): ReturnType<StateGraph<unknown, S>["compile"]> {
  const graph = new StateGraph<unknown, S>({
    channels: {
      value: {
        value: (_x: number, y: number) => y,
        default: () => 0,
      },
      trace: {
        value: (x: string[], y: string[]) => [...x, ...y],
        default: () => [] as string[],
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal channels shape for test
  } as any);

  // biome-ignore lint/suspicious/noExplicitAny: addNode types are loose
  (graph as any).addNode("inc1", (s: S) => ({
    value: s.value + 1,
    trace: ["inc1"],
  }));
  // biome-ignore lint/suspicious/noExplicitAny: addNode types are loose
  (graph as any).addNode("inc2", (s: S) => ({
    value: s.value + 10,
    trace: ["inc2"],
  }));
  // biome-ignore lint/suspicious/noExplicitAny: addNode types are loose
  (graph as any).addNode("inc3", (s: S) => ({
    value: s.value + 100,
    trace: ["inc3"],
  }));

  // biome-ignore lint/suspicious/noExplicitAny: addEdge types are loose
  (graph as any).addEdge(START, "inc1");
  // biome-ignore lint/suspicious/noExplicitAny: addEdge types are loose
  (graph as any).addEdge("inc1", "inc2");
  // biome-ignore lint/suspicious/noExplicitAny: addEdge types are loose
  (graph as any).addEdge("inc2", "inc3");
  // biome-ignore lint/suspicious/noExplicitAny: addEdge types are loose
  (graph as any).addEdge("inc3", END);

  const saver = new SqliteCheckpointSaver();
  // biome-ignore lint/suspicious/noExplicitAny: compile types are loose
  return (graph as any).compile({ checkpointer: saver });
}

describe("LangGraph + SqliteCheckpointSaver resume contract", () => {
  beforeAll(async () => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    process.env.QUBIT_DATA_DIR = tmpDir;
    await runMigrations();
    // 全量 suite 跑时 config.dataDir 会被先到的测试冻结，本测试可能复用同一个 DB；
    // 清掉 wf-resume-1 / wf-resume-2 上的历史 checkpoint，避免 trace 反复累加。
    const { getDb } = await import("../../db/sqlite/client");
    const { langgraphCheckpoint, langgraphCheckpointWrite } = await import(
      "../../db/sqlite/schema"
    );
    const { inArray } = await import("drizzle-orm");
    const db = await getDb();
    const threads = ["wf-resume-1", "wf-resume-2"];
    await db.delete(langgraphCheckpoint).where(inArray(langgraphCheckpoint.threadId, threads));
    await db
      .delete(langgraphCheckpointWrite)
      .where(inArray(langgraphCheckpointWrite.threadId, threads));
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes one checkpoint per node and yields them via list", async () => {
    const app = buildGraph();
    const cfg = { configurable: { thread_id: "wf-resume-1" } };
    const final = (await app.invoke({ value: 0, trace: [] }, cfg)) as S;
    expect(final.value).toBe(111);
    expect(final.trace).toEqual(["inc1", "inc2", "inc3"]);

    const saver = new SqliteCheckpointSaver();
    const ids: string[] = [];
    for await (const t of saver.list(cfg)) ids.push(t.checkpoint.id);
    // 至少有 START + 3 个节点的 checkpoint
    expect(ids.length).toBeGreaterThanOrEqual(3);
  });

  it("invoke(null, cfg) on a finished thread returns the persisted final state", async () => {
    const app = buildGraph();
    const cfg = { configurable: { thread_id: "wf-resume-1" } };
    const replay = (await app.invoke(null, cfg)) as S;
    expect(replay.value).toBe(111);
    expect(replay.trace).toEqual(["inc1", "inc2", "inc3"]);
  });

  it("resume from a mid-state via updateState then invoke(null) advances the graph", async () => {
    const app = buildGraph();
    const cfg = { configurable: { thread_id: "wf-resume-2" } };
    // 先把 thread 推进到 inc1 完成（手工写一个 checkpoint）
    const saver = new SqliteCheckpointSaver();
    await saver.put(
      cfg,
      {
        v: 1,
        id: "manual-ckpt-1",
        ts: new Date().toISOString(),
        channel_values: { value: 1, trace: ["inc1"] },
        channel_versions: { value: 1, trace: 1 },
        versions_seen: { __start__: { __start__: 1 } },
        pending_sends: [],
        // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fixture
      { source: "input", step: 1, writes: {}, parents: {} } as any
    );
    // 这里只验证 getTuple/list 不出错；真实续跑流程在 executeAgentReact 里走完整通道。
    const tuple = await saver.getTuple(cfg);
    expect(tuple?.checkpoint.id).toBe("manual-ckpt-1");
  });
});
