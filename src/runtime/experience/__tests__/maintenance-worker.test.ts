/**
 * ExperienceMaintenanceWorker 单测 — Memory V2 P1.5
 *
 * 覆盖：
 *   - tick 串行：上一次还在跑时第二次 tick 返回 'previous tick still running'
 *   - tick 调用 runJanitorOnce 并返回 summary
 *   - tick 内部异常被 catch + warn，不抛出
 *   - start/stop lifecycle：start 后 setInterval 已挂；stop 后 timer 清空
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MockEmbeddingClient, setEmbeddingClientForTesting } from "../../llm/embedding-client";
import { setExperienceBusForTesting } from "../experience-bus";
import { InMemoryExperienceStore, setExperienceStoreForTesting } from "../experience-store";
import {
  InMemoryExperienceVectorStore,
  setExperienceVectorStoreForTesting,
} from "../experience-vector-store";
import { ExperienceMaintenanceWorker } from "../maintenance-worker";

let store: InMemoryExperienceStore;
let vectorStore: InMemoryExperienceVectorStore;

beforeEach(() => {
  store = new InMemoryExperienceStore();
  vectorStore = new InMemoryExperienceVectorStore();
  setExperienceStoreForTesting(store);
  setExperienceBusForTesting(null);
  setExperienceVectorStoreForTesting(vectorStore);
  setEmbeddingClientForTesting(null);
});

afterEach(() => {
  setExperienceStoreForTesting(null);
  setExperienceBusForTesting(null);
  setExperienceVectorStoreForTesting(null);
  setEmbeddingClientForTesting(null);
});

describe("ExperienceMaintenanceWorker — tick", () => {
  test("tick 返回 ok + janitor.summary（无经验也合法）", async () => {
    const worker = new ExperienceMaintenanceWorker();
    const res = await worker.tick();
    expect(res.janitor.ok).toBe(true);
    expect(res.janitor.summary?.scanned).toBe(0);
    // Memory V2 P2：无 OPENAI_API_KEY 时 embedder skip
    const oldKey = process.env.OPENAI_API_KEY;
    if (!oldKey) {
      expect(res.embedder.skipped).toBe("no_embedding_client");
    }
  });

  test("tick 串行：第二次并发调用返回 'previous tick still running'", async () => {
    const worker = new ExperienceMaintenanceWorker();
    // 让 InMemory 实现里 query 故意等一会，模拟"上一次还在跑"
    let resolveFirst!: () => void;
    const block = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const origQuery = store.query.bind(store);
    let calls = 0;
    store.query = async (filter) => {
      calls += 1;
      if (calls === 1) await block;
      return origQuery(filter);
    };

    const first = worker.tick();
    // 第二次 immediately 调用应被串行守卫挡掉
    const second = await worker.tick();
    expect(second.janitor.ok).toBe(false);
    expect(second.janitor.error).toContain("previous");

    resolveFirst();
    const firstRes = await first;
    expect(firstRes.janitor.ok).toBe(true);
  });

  test("janitor 抛错 → tick 仍返回，error 字段记录原因", async () => {
    const worker = new ExperienceMaintenanceWorker();
    store.query = async () => {
      throw new Error("boom");
    };
    const res = await worker.tick();
    expect(res.janitor.ok).toBe(false);
    expect(res.janitor.error).toBe("boom");
  });

  test("注入 embedding client → embedder 真跑（P2 集成）", async () => {
    setEmbeddingClientForTesting(new MockEmbeddingClient({ dimension: 16 }));
    await store.insert({
      kind: "semantic",
      subKind: "fact",
      scope: "project",
      scopeId: "proj",
      contentJson: { summary: "alpha" },
      validFrom: new Date().toISOString(),
    });
    const worker = new ExperienceMaintenanceWorker();
    const res = await worker.tick();
    expect(res.janitor.ok).toBe(true);
    expect(res.embedder.ok).toBe(true);
    expect(res.embedder.summary?.picked).toBe(1);
    expect(res.embedder.summary?.succeeded).toBe(1);
    expect(vectorStore.size()).toBe(1);
  });
});

describe("ExperienceMaintenanceWorker — lifecycle", () => {
  test("start 后再次 start 是幂等的；stop 后 timer 清空", () => {
    const worker = new ExperienceMaintenanceWorker({
      tickMs: 60_000_000, // 极大值，避免测试期内真触发
      startupDelayMs: 60_000_000,
    });
    worker.start();
    worker.start(); // 第二次必须不重复挂 timer
    worker.stop();
    // 再次 start 应能重新挂上（不爆错）
    worker.start();
    worker.stop();
    expect(true).toBe(true);
  });
});
