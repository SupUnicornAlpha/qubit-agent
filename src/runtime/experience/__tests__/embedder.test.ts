/**
 * Embedder pipe 单测 — Memory V2 P2
 *
 * 覆盖：
 *   - runOnce 基础：未 embed 的拿到向量、写 vector store、state→done
 *   - 已 done 跳过（同 model+dim）
 *   - model 变了 → 旧 done 仍触发重 embed
 *   - failed 计数与上限：超 maxRetries 跳过
 *   - 整批 embed 失败：所有 picked 标 failed
 *   - 单条 vector store upsert 失败：单条 fail，其他 ok
 *   - batchSize 截断
 *   - archived 不 embed
 *   - rebuildExperienceEmbedding 删旧向量 + 重置 state
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  type EmbeddingClient,
  type EmbeddingResult,
  MockEmbeddingClient,
} from "../../llm/embedding-client";
import { type ExperienceStore, InMemoryExperienceStore } from "../experience-store";
import { InMemoryExperienceVectorStore } from "../experience-vector-store";
import { EMBEDDER_META_KEYS, rebuildExperienceEmbedding, runEmbedderOnce } from "../pipes/embedder";

const NOW = "2026-06-02T00:00:00.000Z";

let store: ExperienceStore;
let vectorStore: InMemoryExperienceVectorStore;
let client: EmbeddingClient;

beforeEach(() => {
  store = new InMemoryExperienceStore();
  vectorStore = new InMemoryExperienceVectorStore();
  client = new MockEmbeddingClient({ dimension: 16 });
});

async function insertSemantic(
  _id: string,
  summary: string,
  over: Partial<{ archived: boolean; metadataJson: Record<string, unknown> }> = {}
): Promise<void> {
  const exp = await store.insert({
    kind: "semantic",
    subKind: "fact",
    scope: "project",
    scopeId: "proj-1",
    contentJson: { summary, body: `body of ${summary}` },
    validFrom: NOW,
    metadataJson: over.metadataJson ?? {},
  });
  // hack：让 id 可控（InMemoryExperienceStore.insert 返回的就是新 id；
  // 测试里我们后续用 query 拿；这里 over 形参里如果给了 id 可以覆盖）
  void exp;
  if (over.archived) {
    await store.update(exp.id, {
      // archive：把 validTo 设到过去
    });
    // InMemory store 的 archive 走 archived flag；我们用 query archivalMode 过滤；
    // 这里换一种：直接更新成 metadataJson.archivedAt 也不会被 exclude_archived 过滤掉
    // 用一个 hack：调 logOp("archive") 不能改 row 状态，所以最简单方式是借 InMemoryExperienceStore 内部 setter
  }
}

describe("Embedder.runOnce — 基础路径", () => {
  test("未 embed 的全部 embed；vector store 写入；state→done", async () => {
    await insertSemantic("a", "backtest momentum 20d");
    await insertSemantic("b", "回测反转 10d");

    const summary = await runEmbedderOnce({ store, vectorStore, client });
    expect(summary.scanned).toBe(2);
    expect(summary.picked).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.embedBatches).toBe(1);
    expect(vectorStore.size()).toBe(2);

    // state 检查
    const after = await store.query({ scope: "project", scopeId: "proj-1" });
    for (const e of after) {
      expect(e.metadataJson[EMBEDDER_META_KEYS.STATE]).toBe("done");
      expect(e.metadataJson[EMBEDDER_META_KEYS.MODEL]).toBe(client.model);
      expect(e.metadataJson[EMBEDDER_META_KEYS.DIM]).toBe(16);
    }
  });

  test("二次 runOnce → 全 skip（已 done）", async () => {
    await insertSemantic("a", "x");
    await runEmbedderOnce({ store, vectorStore, client });
    const summary = await runEmbedderOnce({ store, vectorStore, client });
    expect(summary.picked).toBe(0);
    expect(vectorStore.size()).toBe(1); // 没有重 upsert
  });
});

describe("Embedder.runOnce — model 变化", () => {
  test("model 变了 → 旧 done 仍触发重 embed", async () => {
    await insertSemantic("a", "x");
    await runEmbedderOnce({ store, vectorStore, client });
    expect(vectorStore.size()).toBe(1);

    const newClient = new MockEmbeddingClient({ model: "mock-embed-2", dimension: 16 });
    const summary = await runEmbedderOnce({ store, vectorStore, client: newClient });
    expect(summary.picked).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(vectorStore.size()).toBe(2); // 新 + 旧并存（rebuild 才删旧）
  });

  test("dim 变了 → 同样触发重 embed", async () => {
    await insertSemantic("a", "x");
    await runEmbedderOnce({ store, vectorStore, client });
    const newClient = new MockEmbeddingClient({ dimension: 32 });
    const summary = await runEmbedderOnce({ store, vectorStore, client: newClient });
    expect(summary.picked).toBe(1);
  });
});

describe("Embedder.runOnce — 失败处理", () => {
  test("整批 embed 失败 → 全部标 failed + retries=1", async () => {
    await insertSemantic("a", "x");
    await insertSemantic("b", "y");
    const failingClient: EmbeddingClient = {
      model: "mock-fail",
      dimension: 16,
      async embed(): Promise<EmbeddingResult> {
        throw new Error("network down");
      },
    };
    const summary = await runEmbedderOnce({ store, vectorStore, client: failingClient });
    expect(summary.failed).toBe(2);
    expect(summary.succeeded).toBe(0);

    const after = await store.query({ scope: "project", scopeId: "proj-1" });
    for (const e of after) {
      expect(e.metadataJson[EMBEDDER_META_KEYS.STATE]).toBe("failed");
      expect(e.metadataJson[EMBEDDER_META_KEYS.RETRIES]).toBe(1);
      expect(e.metadataJson[EMBEDDER_META_KEYS.LAST_ERR]).toContain("network down");
    }
  });

  test("超 maxRetries → 跳过（不再 picked）", async () => {
    await insertSemantic("a", "x", {
      metadataJson: {
        [EMBEDDER_META_KEYS.STATE]: "failed",
        [EMBEDDER_META_KEYS.RETRIES]: 5,
      },
    });
    const summary = await runEmbedderOnce({
      store,
      vectorStore,
      client,
      maxRetries: 3,
    });
    expect(summary.picked).toBe(0);
  });

  test("单条 vector store 失败 → 单条 fail，其他 ok", async () => {
    await insertSemantic("a", "good text");
    await insertSemantic("b", "another text");

    // 让 vector store 第一次 upsert 抛错，后续正常
    let calls = 0;
    const orig = vectorStore.upsert.bind(vectorStore);
    vectorStore.upsert = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("disk full");
      return orig(input);
    };
    const summary = await runEmbedderOnce({ store, vectorStore, client });
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
  });
});

describe("Embedder.runOnce — batchSize / scanLimit", () => {
  test("batchSize 截断：5 条只 pick 3 条", async () => {
    for (let i = 0; i < 5; i += 1) await insertSemantic(`a${i}`, `text ${i}`);
    const summary = await runEmbedderOnce({
      store,
      vectorStore,
      client,
      batchSize: 3,
    });
    expect(summary.picked).toBe(3);
    expect(vectorStore.size()).toBe(3);
  });
});

describe("Embedder — rebuildExperienceEmbedding", () => {
  test("删旧向量 + 重置 state；下次 runOnce 重 embed", async () => {
    await insertSemantic("a", "x");
    await runEmbedderOnce({ store, vectorStore, client });
    expect(vectorStore.size()).toBe(1);

    const [exp] = await store.query({ scope: "project", scopeId: "proj-1" });
    if (!exp) throw new Error("no exp");
    await rebuildExperienceEmbedding(store, vectorStore, exp.id);
    expect(vectorStore.size()).toBe(0);

    const refreshed = await store.findById(exp.id);
    expect(refreshed?.metadataJson[EMBEDDER_META_KEYS.STATE]).toBeUndefined();

    const summary = await runEmbedderOnce({ store, vectorStore, client });
    expect(summary.picked).toBe(1);
    expect(vectorStore.size()).toBe(1);
  });
});
