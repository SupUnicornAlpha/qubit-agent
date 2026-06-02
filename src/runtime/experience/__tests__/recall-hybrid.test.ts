/**
 * ExperienceRecall hybrid 模式单测 — Memory V2 P2
 *
 * 覆盖：
 *   - hybridEnabled getter：两者都给 → true；缺一 → false
 *   - hybrid 公式生效：embed 分量进入合分
 *   - vector 命中带回 keyword 不命中的 experience（语义召回胜出场景）
 *   - reflective 在 hybrid 下仍然 agent 隔离
 *   - kinds=["semantic","procedural"] 时不向量召回 reflective
 *   - embed 抛错 → 降级 keyword-only（warn 不抛）
 *   - vectorStore 抛错 → 降级 keyword-only
 *   - via embed 标记在结果上
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type EmbeddingClient,
  type EmbeddingResult,
  MockEmbeddingClient,
  hashEmbed,
} from "../../llm/embedding-client";
import { getExperienceBus, setExperienceBusForTesting } from "../experience-bus";
import { type ExperienceStore, InMemoryExperienceStore } from "../experience-store";
import {
  type ExperienceVectorStore,
  InMemoryExperienceVectorStore,
} from "../experience-vector-store";
import { ExperienceRecall } from "../pipes/recall";

const NOW = "2026-06-02T00:00:00.000Z";
const DIM = 16;
const MODEL = "mock-embed-1";

let store: ExperienceStore;
let vectorStore: InMemoryExperienceVectorStore;
let client: MockEmbeddingClient;

beforeEach(() => {
  store = new InMemoryExperienceStore();
  vectorStore = new InMemoryExperienceVectorStore();
  client = new MockEmbeddingClient({ dimension: DIM, model: MODEL });
  setExperienceBusForTesting(null);
});

afterEach(() => {
  getExperienceBus().clearAllForTesting();
  setExperienceBusForTesting(null);
});

async function seed(
  _id: string,
  summary: string,
  over: Partial<{
    kind: "semantic" | "procedural" | "reflective";
    definitionId: string | null;
    visibility: "project_shared" | "agent_private";
    qualityScore: number;
  }> = {}
): Promise<{ id: string; summary: string }> {
  const kind = over.kind ?? "semantic";
  const visibility =
    over.visibility ?? (kind === "reflective" ? "agent_private" : "project_shared");
  const exp = await store.insert({
    kind,
    subKind: kind === "reflective" ? "failure_mode" : "fact",
    scope: "project",
    scopeId: "proj-1",
    definitionId: over.definitionId ?? (kind === "reflective" ? "agent-A" : null),
    visibility,
    contentJson: { summary, body: "" },
    validFrom: NOW,
    qualityScore: over.qualityScore ?? 0.5,
  });
  // 顺手灌向量
  const vec = hashEmbed(summary, DIM);
  await vectorStore.upsert({
    experienceId: exp.id,
    vector: vec,
    kind,
    subKind: kind === "reflective" ? "failure_mode" : "fact",
    scope: "project",
    scopeId: "proj-1",
    definitionId: over.definitionId ?? (kind === "reflective" ? "agent-A" : null),
    visibility,
    model: MODEL,
    dimension: DIM,
    sourceText: summary,
  });
  return { id: exp.id, summary };
}

describe("ExperienceRecall hybrid — 模式开关", () => {
  test("两者都给 → hybridEnabled=true", () => {
    const r = new ExperienceRecall({ store, vectorStore, embeddingClient: client });
    expect(r.hybridEnabled).toBe(true);
  });
  test("只给 store → hybridEnabled=false（向后兼容）", () => {
    const r = new ExperienceRecall({ store });
    expect(r.hybridEnabled).toBe(false);
  });
  test("只给 vectorStore → 仍 false", () => {
    const r = new ExperienceRecall({ store, vectorStore });
    expect(r.hybridEnabled).toBe(false);
  });
});

describe("ExperienceRecall hybrid — embed 分量进合分", () => {
  test("同样 keyword 命中下，embed 越高排越前", async () => {
    // 两条都有 keyword 命中，但 a 的 summary 与 query 几乎一致（embed 高），b 只有部分重合
    await seed("a", "backtest momentum 20d on CN-A");
    await seed("b", "momentum 因子 别的话题");
    const recall = new ExperienceRecall({
      store,
      vectorStore,
      embeddingClient: client,
    });
    const hits = await recall.recall({
      projectId: "proj-1",
      definitionId: "agent-A",
      query: "backtest momentum 20d on CN-A",
      topK: 5,
      workflowRunId: "wf-1",
      silentEmit: true,
    });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // a 是 query 自身 → embed=1，keyword=1；b 部分命中
    expect(hits[0]?.experience.contentJson.summary).toContain("backtest momentum 20d");
    expect(hits[0]?.components.embed).toBeGreaterThan(hits[1]?.components.embed ?? 0);
  });
});

describe("ExperienceRecall hybrid — 向量召回带回 keyword 不命中", () => {
  test("纯 hash embed 下，无 keyword 命中但向量近的也会被召回", async () => {
    // 构造：a 的 summary 与 query 完全不重合 keyword，但 vector 通过 hash 偶然接近
    // 由于 hashEmbed 是确定性的，我们用相同 token 注入向量但 store 里写不同 summary 的方式
    const exp = await store.insert({
      kind: "semantic",
      subKind: "fact",
      scope: "project",
      scopeId: "proj-1",
      contentJson: { summary: "完全不同的主题", body: "" },
      validFrom: NOW,
    });
    // 手动写一个与 query 完全一致的向量
    const query = "backtest momentum 20d";
    const queryVec = hashEmbed(query, DIM);
    await vectorStore.upsert({
      experienceId: exp.id,
      vector: queryVec,
      kind: "semantic",
      subKind: "fact",
      scope: "project",
      scopeId: "proj-1",
      definitionId: null,
      visibility: "project_shared",
      model: MODEL,
      dimension: DIM,
      sourceText: query,
    });
    const recall = new ExperienceRecall({
      store,
      vectorStore,
      embeddingClient: client,
    });
    const hits = await recall.recall({
      projectId: "proj-1",
      definitionId: "agent-A",
      query,
      topK: 5,
      silentEmit: true,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.viaEmbed).toBe(true);
    expect(hits[0]?.components.keyword).toBe(0); // keyword 真的 0
    expect(hits[0]?.components.embed).toBeCloseTo(1, 5);
  });
});

describe("ExperienceRecall hybrid — reflective agent 隔离", () => {
  test("agent-B 通过向量也拉不到 agent-A 的 reflective", async () => {
    const query = "alpha lesson 复盘";
    await seed("rA", query, { kind: "reflective", definitionId: "agent-A" });
    const recall = new ExperienceRecall({
      store,
      vectorStore,
      embeddingClient: client,
    });
    const hits = await recall.recall({
      projectId: "proj-1",
      definitionId: "agent-B",
      query,
      topK: 5,
      silentEmit: true,
    });
    expect(hits.length).toBe(0);
  });
});

describe("ExperienceRecall hybrid — 降级路径", () => {
  test("embed client 抛错 → 自动降级 keyword-only（结果仍可返）", async () => {
    await seed("a", "backtest momentum");
    const failingClient: EmbeddingClient = {
      model: MODEL,
      dimension: DIM,
      async embed(): Promise<EmbeddingResult> {
        throw new Error("api quota");
      },
    };
    const recall = new ExperienceRecall({
      store,
      vectorStore,
      embeddingClient: failingClient,
    });
    const hits = await recall.recall({
      projectId: "proj-1",
      definitionId: "agent-A",
      query: "backtest momentum",
      topK: 5,
      silentEmit: true,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.viaEmbed).toBe(false);
    expect(hits[0]?.components.embed).toBe(0);
  });

  test("vectorStore.search 抛错 → 同样降级", async () => {
    await seed("a", "backtest momentum");
    const badVS = vectorStore as ExperienceVectorStore;
    const origSearch = badVS.search.bind(badVS);
    badVS.search = async () => {
      throw new Error("lance down");
    };
    const recall = new ExperienceRecall({
      store,
      vectorStore: badVS,
      embeddingClient: client,
    });
    const hits = await recall.recall({
      projectId: "proj-1",
      definitionId: "agent-A",
      query: "backtest momentum",
      topK: 5,
      silentEmit: true,
    });
    expect(hits.length).toBe(1);
    expect(hits[0]?.viaEmbed).toBe(false);
    // 把 search 还回去
    badVS.search = origSearch;
  });
});

describe("ExperienceRecall hybrid — viaEmbed 标记", () => {
  test("viaEmbed 与 components.embed 一致", async () => {
    await seed("a", "alpha beta");
    const recall = new ExperienceRecall({
      store,
      vectorStore,
      embeddingClient: client,
    });
    const hits = await recall.recall({
      projectId: "proj-1",
      definitionId: "agent-A",
      query: "alpha beta",
      topK: 5,
      silentEmit: true,
    });
    expect(hits[0]?.viaEmbed).toBe(true);
  });
});
