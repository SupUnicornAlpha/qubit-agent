/**
 * ExperienceRecall 单测 — Memory V2 P1
 *
 * 覆盖：
 *   - 关键词 tokenize（中英混合）+ keyword 命中得分
 *   - recency 衰减
 *   - visibility 路由：reflective 仅 agent_private、不串到别的 agent
 *   - link 1 跳扩展（derive_from / evidence_of）
 *   - dedupe：同一 exp 出现多次只留最高分
 *   - emit experience_recalled fire-and-forget
 *   - renderRecallBlockForPrompt 输出 Markdown
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getExperienceBus, setExperienceBusForTesting } from "../experience-bus";
import { InMemoryExperienceStore, setExperienceStoreForTesting } from "../experience-store";
import {
  ExperienceRecall,
  keywordScore,
  recencyScore,
  renderRecallBlockForPrompt,
  tokenize,
} from "../pipes/recall";

let store: InMemoryExperienceStore;
let bus: ReturnType<typeof getExperienceBus>;

beforeEach(() => {
  store = new InMemoryExperienceStore();
  setExperienceStoreForTesting(store);
  setExperienceBusForTesting(null);
  bus = getExperienceBus();
});

afterEach(() => {
  bus.clearAllForTesting();
  setExperienceStoreForTesting(null);
  setExperienceBusForTesting(null);
});

describe("Recall — 纯函数", () => {
  test("tokenize 中英混合", () => {
    const ts = tokenize("评估 momentum_20d 在 CN-A 的 Sharpe");
    expect(ts).toContain("momentum_20d");
    expect(ts).toContain("cn-a");
    expect(ts).toContain("sharpe");
    expect(ts).toContain("评");
    expect(ts).toContain("估");
  });

  test("keywordScore 比例", () => {
    expect(keywordScore("alpha sharpe IR good", ["alpha", "sharpe", "missing"])).toBeCloseTo(
      2 / 3,
      5
    );
    expect(keywordScore("anything", [])).toBe(0);
  });

  test("recencyScore 越旧越小", () => {
    const now = new Date("2026-06-30T00:00:00.000Z");
    const today = recencyScore("2026-06-30T00:00:00.000Z", now);
    const old = recencyScore("2026-04-01T00:00:00.000Z", now);
    expect(today).toBeCloseTo(1, 3);
    expect(old).toBeLessThan(0.2);
  });
});

describe("Recall — 池子收集 & 评分", () => {
  test("semantic 全捞 + reflective 只命中自己", async () => {
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "proj-1",
      contentJson: { summary: "momentum factor evaluated on CN-A: Sharpe 1.3 IR 0.8" },
      validFrom: "2026-06-25T00:00:00.000Z",
      qualityScore: 0.7,
    });
    await store.insert({
      kind: "reflective",
      scope: "project",
      scopeId: "proj-1",
      definitionId: "def-research",
      visibility: "agent_private",
      contentJson: { summary: "lesson: momentum on small universe triggers timeout" },
      validFrom: "2026-06-25T00:00:00.000Z",
      qualityScore: 0.6,
    });
    await store.insert({
      kind: "reflective",
      scope: "project",
      scopeId: "proj-1",
      definitionId: "def-other", // 不该被 def-research 看到
      visibility: "agent_private",
      contentJson: { summary: "other agent momentum private note" },
      validFrom: "2026-06-25T00:00:00.000Z",
      qualityScore: 0.6,
    });

    const recall = new ExperienceRecall({
      store,
      bus,
      now: () => new Date("2026-06-30T00:00:00.000Z"),
    });
    const out = await recall.recall({
      projectId: "proj-1",
      definitionId: "def-research",
      query: "momentum CN-A Sharpe",
      topK: 10,
    });

    expect(out.length).toBe(2);
    const summaries = out.map((r) => r.experience.contentJson.summary ?? "");
    expect(summaries.some((s) => s.includes("momentum factor"))).toBe(true);
    expect(summaries.some((s) => s.includes("small universe"))).toBe(true);
    expect(summaries.every((s) => !s.includes("other agent"))).toBe(true);
  });

  test("已归档（validTo!=null）不进池", async () => {
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "archived but matches keyword foo" },
      validFrom: "2026-01-01T00:00:00.000Z",
      validTo: "2026-06-01T00:00:00.000Z",
    });
    const recall = new ExperienceRecall({ store, bus });
    const out = await recall.recall({
      projectId: "p",
      definitionId: null,
      query: "foo",
      topK: 5,
    });
    expect(out.length).toBe(0);
  });

  test("score = 0.5*kw + 0.3*q + 0.2*recency 排序生效", async () => {
    const now = new Date("2026-06-30T00:00:00.000Z");
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "matching keyword alpha", body: "alpha alpha alpha" },
      validFrom: "2026-06-29T00:00:00.000Z",
      qualityScore: 0.9, // 高 q
    });
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "matching keyword alpha low q", body: "alpha" },
      validFrom: "2026-06-29T00:00:00.000Z",
      qualityScore: 0.1, // 低 q
    });
    const recall = new ExperienceRecall({ store, bus, now: () => now });
    const out = await recall.recall({
      projectId: "p",
      definitionId: null,
      query: "alpha",
      topK: 5,
    });
    expect(out[0]?.experience.qualityScore).toBe(0.9);
    expect(out[0]?.score).toBeGreaterThan(out[1]?.score ?? 0);
  });
});

describe("Recall — link 1 跳扩展", () => {
  test("seed 命中后通过 evidence_of 拉回邻居", async () => {
    const seed = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "momentum factor primary doc" },
      validFrom: "2026-06-25T00:00:00.000Z",
      qualityScore: 0.7,
    });
    const neighbor = await store.insert({
      kind: "procedural",
      scope: "project",
      scopeId: "p",
      // 故意不含关键词 "momentum"，确保只能通过 link 进入
      contentJson: { summary: "playbook for cross-sectional factor studies" },
      validFrom: "2026-06-25T00:00:00.000Z",
      qualityScore: 0.6,
    });
    await store.linkAdd(seed.id, neighbor.id, "evidence_of", 1.0);

    const recall = new ExperienceRecall({ store, bus });
    const out = await recall.recall({
      projectId: "p",
      definitionId: null,
      query: "momentum",
      topK: 5,
    });
    const ids = out.map((r) => r.experience.id);
    expect(ids).toContain(seed.id);
    expect(ids).toContain(neighbor.id);
    const neighborRes = out.find((r) => r.experience.id === neighbor.id);
    expect(neighborRes?.viaLink).toBe(true);
  });

  test("seed 重复出现时只留最高分（dedupe）", async () => {
    const a = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "alpha beta" },
      validFrom: "2026-06-25T00:00:00.000Z",
      qualityScore: 0.8,
    });
    const b = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "alpha gamma" },
      validFrom: "2026-06-25T00:00:00.000Z",
      qualityScore: 0.8,
    });
    // a → b（让 b 通过 link 第二次进来）
    await store.linkAdd(a.id, b.id, "derive_from", 1.0);

    const recall = new ExperienceRecall({ store, bus });
    const out = await recall.recall({
      projectId: "p",
      definitionId: null,
      query: "alpha",
      topK: 10,
    });
    const bRows = out.filter((r) => r.experience.id === b.id);
    expect(bRows.length).toBe(1);
  });
});

describe("Recall — emit experience_recalled", () => {
  test("命中后 emit 给 Bus 让 Writer 写 op_log", async () => {
    const exp = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "shared knowledge x" },
      validFrom: "2026-06-25T00:00:00.000Z",
      qualityScore: 0.7,
    });
    const captured: unknown[] = [];
    bus.subscribe("experience_recalled", (ev) => {
      captured.push(ev);
    });

    const recall = new ExperienceRecall({ store, bus });
    await recall.recall({
      projectId: "p",
      definitionId: null,
      query: "shared knowledge",
      topK: 3,
      workflowRunId: "wf-r",
    });
    await bus.awaitIdle();
    expect(captured.length).toBe(1);
    expect((captured[0] as { experienceId: string }).experienceId).toBe(exp.id);
  });

  test("silentEmit=true 不发事件", async () => {
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "x" },
      validFrom: "2026-06-25T00:00:00.000Z",
    });
    let count = 0;
    bus.subscribe("experience_recalled", () => {
      count += 1;
    });
    const recall = new ExperienceRecall({ store, bus });
    await recall.recall({
      projectId: "p",
      definitionId: null,
      query: "x",
      topK: 3,
      workflowRunId: "wf",
      silentEmit: true,
    });
    await bus.awaitIdle();
    expect(count).toBe(0);
  });
});

describe("Recall — Prompt 渲染", () => {
  test("空数组 → 空字符串", () => {
    expect(renderRecallBlockForPrompt([])).toBe("");
  });

  test("非空 → Markdown 含 score / kind", () => {
    const md = renderRecallBlockForPrompt([
      {
        experience: {
          id: "e1",
          kind: "semantic",
          subKind: "factor_archive",
          scope: "project",
          scopeId: "p",
          definitionId: null,
          visibility: "project_shared",
          contentJson: { summary: "momentum CN-A Sharpe 1.3", body: "" },
          tagsJson: [],
          qualityScore: 0.7,
          useCount: 12,
          successCount: 10,
          failCount: 2,
          decayAt: null,
          validFrom: "2026-06-25T00:00:00.000Z",
          validTo: null,
          parentId: null,
          sourceRunId: null,
          embeddingRef: null,
          pinned: false,
          metadataJson: {},
          createdAt: "2026-06-25T00:00:00.000Z",
          updatedAt: "2026-06-25T00:00:00.000Z",
        },
        score: 0.812,
        components: { keyword: 1, quality: 0.7, recency: 0.9 },
        rank: 0,
        viaLink: false,
      },
    ]);
    expect(md).toContain("Memory · Recall (live)");
    expect(md).toContain("[semantic/factor_archive]");
    expect(md).toContain("score=0.812");
    expect(md).toContain("use=12");
  });
});
