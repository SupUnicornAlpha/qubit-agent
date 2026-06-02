/**
 * InMemoryExperienceVectorStore 单测 — Memory V2 P2
 *
 * 覆盖：
 *   - upsert → search 基本路径：相同向量 cosine=1，能拿到自己
 *   - filter：scope/scopeId/kinds/visibilities pre-filter 正确
 *   - reflective：必须传 definitionId；不一致的 agent 拉不到
 *   - 多模型并存：不同 model 互不干扰
 *   - dim mismatch → 抛错（query dim ≠ filter.dimension）
 *   - deleteByExperience 真删
 *   - 同 experienceId 多次 upsert（向量演化）→ search 返 top1（dedup）
 */

import { describe, expect, test } from "bun:test";
import { MockEmbeddingClient, hashEmbed } from "../../llm/embedding-client";
import {
  InMemoryExperienceVectorStore,
  type UpsertEmbeddingInput,
} from "../experience-vector-store";

const DIM = 16;

function input(
  over: Partial<UpsertEmbeddingInput> & { experienceId: string; text: string }
): UpsertEmbeddingInput {
  return {
    experienceId: over.experienceId,
    vector: over.vector ?? hashEmbed(over.text, DIM),
    kind: over.kind ?? "semantic",
    subKind: over.subKind ?? "fact",
    scope: over.scope ?? "project",
    scopeId: over.scopeId ?? "proj-1",
    definitionId: over.definitionId ?? null,
    visibility: over.visibility ?? "project_shared",
    model: over.model ?? "mock-embed-1",
    dimension: over.dimension ?? DIM,
    sourceText: over.sourceText ?? over.text,
  };
}

describe("InMemoryExperienceVectorStore — upsert/search 基础", () => {
  test("自身向量 → cosine=1，能拿到自己", async () => {
    const store = new InMemoryExperienceVectorStore();
    const text = "backtest momentum 20d on CN-A";
    await store.upsert(input({ experienceId: "e1", text }));
    const hits = await store.search(
      hashEmbed(text, DIM),
      {
        scope: "project",
        scopeId: "proj-1",
        model: "mock-embed-1",
        dimension: DIM,
      },
      5
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.experienceId).toBe("e1");
    expect(hits[0]?.score).toBeCloseTo(1, 6);
  });

  test("topK 截断；按 score 降序", async () => {
    const store = new InMemoryExperienceVectorStore();
    await store.upsert(input({ experienceId: "e1", text: "alpha beta gamma" }));
    await store.upsert(input({ experienceId: "e2", text: "alpha xxx" }));
    await store.upsert(input({ experienceId: "e3", text: "yyy zzz" }));
    const hits = await store.search(
      hashEmbed("alpha", DIM),
      {
        scope: "project",
        scopeId: "proj-1",
        model: "mock-embed-1",
        dimension: DIM,
      },
      2
    );
    expect(hits.length).toBe(2);
    expect(hits[0]?.score).toBeGreaterThanOrEqual(hits[1]?.score ?? 0);
  });
});

describe("InMemoryExperienceVectorStore — filter", () => {
  test("scope/scopeId 不匹配 → 不返", async () => {
    const store = new InMemoryExperienceVectorStore();
    await store.upsert(input({ experienceId: "e1", text: "foo bar", scopeId: "other-proj" }));
    const hits = await store.search(
      hashEmbed("foo bar", DIM),
      {
        scope: "project",
        scopeId: "proj-1",
        model: "mock-embed-1",
        dimension: DIM,
      },
      5
    );
    expect(hits.length).toBe(0);
  });

  test("kinds 白名单：semantic + procedural 不拿 episodic", async () => {
    const store = new InMemoryExperienceVectorStore();
    await store.upsert(input({ experienceId: "se", text: "alpha", kind: "semantic" }));
    await store.upsert(input({ experienceId: "pr", text: "alpha", kind: "procedural" }));
    await store.upsert(input({ experienceId: "ep", text: "alpha", kind: "episodic" }));
    const hits = await store.search(
      hashEmbed("alpha", DIM),
      {
        scope: "project",
        scopeId: "proj-1",
        model: "mock-embed-1",
        dimension: DIM,
        kinds: ["semantic", "procedural"],
      },
      5
    );
    const ids = hits.map((h) => h.experienceId);
    expect(ids).toContain("se");
    expect(ids).toContain("pr");
    expect(ids).not.toContain("ep");
  });
});

describe("InMemoryExperienceVectorStore — reflective 隔离", () => {
  test("reflective 必须传 definitionId；不一致 agent 拉不到", async () => {
    const store = new InMemoryExperienceVectorStore();
    await store.upsert(
      input({
        experienceId: "r-A",
        text: "alpha lesson",
        kind: "reflective",
        visibility: "agent_private",
        definitionId: "agent-A",
      })
    );

    const filter = {
      scope: "project",
      scopeId: "proj-1",
      model: "mock-embed-1",
      dimension: DIM,
      kinds: ["reflective"],
      visibilities: ["agent_private"],
    };

    // agent-B 拉不到 agent-A 的反思
    const hitsB = await store.search(
      hashEmbed("alpha lesson", DIM),
      { ...filter, definitionId: "agent-B" },
      5
    );
    expect(hitsB.length).toBe(0);

    // agent-A 能拉到自己
    const hitsA = await store.search(
      hashEmbed("alpha lesson", DIM),
      { ...filter, definitionId: "agent-A" },
      5
    );
    expect(hitsA[0]?.experienceId).toBe("r-A");

    // 不传 definitionId 也拉不到 reflective（避免越权）
    const hitsNoDef = await store.search(hashEmbed("alpha lesson", DIM), filter, 5);
    expect(hitsNoDef.length).toBe(0);
  });
});

describe("InMemoryExperienceVectorStore — 多模型 / dim", () => {
  test("不同 model 互不召回", async () => {
    const store = new InMemoryExperienceVectorStore();
    await store.upsert(input({ experienceId: "e1", text: "x", model: "mock-embed-1" }));
    await store.upsert(input({ experienceId: "e2", text: "x", model: "mock-embed-2" }));
    const hits = await store.search(
      hashEmbed("x", DIM),
      {
        scope: "project",
        scopeId: "proj-1",
        model: "mock-embed-1",
        dimension: DIM,
      },
      5
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.experienceId).toBe("e1");
  });

  test("query 维度 != filter.dimension → 抛错", async () => {
    const store = new InMemoryExperienceVectorStore();
    await expect(
      store.search(
        [1, 2, 3],
        {
          scope: "project",
          scopeId: "proj-1",
          model: "mock-embed-1",
          dimension: 16,
        },
        5
      )
    ).rejects.toThrow(/dim/);
  });
});

describe("InMemoryExperienceVectorStore — 增删", () => {
  test("deleteByExperience 真删；返回删除条数", async () => {
    const store = new InMemoryExperienceVectorStore();
    await store.upsert(input({ experienceId: "e1", text: "x" }));
    await store.upsert(input({ experienceId: "e1", text: "x2" })); // 同 experienceId 多版本
    await store.upsert(input({ experienceId: "e2", text: "y" }));
    expect(store.size()).toBe(3);
    const n = await store.deleteByExperience("e1");
    expect(n).toBe(2);
    expect(store.size()).toBe(1);
  });

  test("同 experienceId 多次 upsert → search 返 top1（dedup）", async () => {
    const store = new InMemoryExperienceVectorStore();
    await store.upsert(input({ experienceId: "e1", text: "alpha lesson v1" }));
    await store.upsert(input({ experienceId: "e1", text: "alpha lesson v2" }));
    const hits = await store.search(
      hashEmbed("alpha lesson", DIM),
      {
        scope: "project",
        scopeId: "proj-1",
        model: "mock-embed-1",
        dimension: DIM,
      },
      5
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.experienceId).toBe("e1");
  });
});

describe("InMemoryExperienceVectorStore — 与 MockEmbeddingClient 协作", () => {
  test("把 EmbeddingClient 拿到的向量灌入 store → search 正常", async () => {
    const emb = new MockEmbeddingClient({ dimension: DIM });
    const store = new InMemoryExperienceVectorStore();
    const texts = ["回测动量 20d", "回测反转 10d", "新闻情绪因子"];
    const res = await emb.embed(texts);
    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i];
      const vector = res.vectors[i];
      if (!text || !vector) throw new Error("unreachable");
      await store.upsert(input({ experienceId: `e${i}`, text, vector }));
    }
    const q = await emb.embed(["回测动量 20d 在 A 股的表现"]);
    const qVec = q.vectors[0];
    if (!qVec) throw new Error("unreachable");
    const hits = await store.search(
      qVec,
      {
        scope: "project",
        scopeId: "proj-1",
        model: "mock-embed-1",
        dimension: DIM,
      },
      3
    );
    expect(hits[0]?.experienceId).toBe("e0"); // 最像的应该是「回测动量 20d」
  });
});
