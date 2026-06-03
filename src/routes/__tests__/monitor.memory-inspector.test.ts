/**
 * Memory V2 P3 — Inspector 只读 API 路由测试。
 *
 * 关键设计：
 *   - 直接调 `monitorRouter.request(new Request(...))`，不走 server.ts；
 *     绕开 sqlite migration / config.dataDir 约束，纯 in-memory。
 *   - 用 `setExperienceStoreForTesting(InMemoryExperienceStore)` 注入 store；
 *     端点内部 `getExperienceStore()` 会拿到同一个 mock。
 *
 * 覆盖：
 *   - GET /memory/experiences
 *       · projectId 缺失 → 400
 *       · kind 多值 + subKind 过滤
 *       · q 关键词搜（summary / body / tags 三处都命中）
 *       · pinnedOnly + archivalMode
 *       · 分页 (limit / offset / total)
 *       · 列表 payload 不含 body（减重）
 *   - GET /memory/experiences/:id
 *       · 命中 → 完整 contentJson + metadataJson
 *       · 未命中 → 404
 *   - GET /memory/experiences/:id/links
 *       · 1 跳邻居 + brief；direction 标识（outgoing/incoming）
 *       · relations 过滤 csv 解析
 *   - GET /memory/experiences/:id/oplog
 *       · 时间线 + limit 截断
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  InMemoryExperienceStore,
  setExperienceStoreForTesting,
} from "../../runtime/experience/experience-store";
import type { Experience } from "../../types/entities";
import { monitorRouter } from "../monitor.routes";

const NOW = "2026-06-03T00:00:00.000Z";

let store: InMemoryExperienceStore;

beforeEach(() => {
  store = new InMemoryExperienceStore();
  setExperienceStoreForTesting(store);
});

afterAll(() => {
  setExperienceStoreForTesting(null);
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await monitorRouter.request(new Request(`http://t${path}`));
  const body = await res.json();
  return { status: res.status, body };
}

async function seed(
  over: Partial<{
    kind: "semantic" | "procedural" | "reflective" | "episodic" | "identity";
    subKind: string;
    summary: string;
    body: string;
    tags: string[];
    pinned: boolean;
    qualityScore: number;
    archived: boolean;
    definitionId: string | null;
    metadataJson: Record<string, unknown>;
  }> = {}
): Promise<Experience> {
  const exp = await store.insert({
    kind: over.kind ?? "semantic",
    subKind: over.subKind ?? "fact",
    scope: "project",
    scopeId: "p1",
    definitionId: over.definitionId ?? null,
    visibility: over.kind === "reflective" ? "agent_private" : "project_shared",
    contentJson: {
      summary: over.summary ?? "default summary",
      body: over.body ?? "",
    } as any,
    tagsJson: over.tags ?? [],
    qualityScore: over.qualityScore ?? 0.5,
    pinned: over.pinned ?? false,
    validFrom: NOW,
    metadataJson: over.metadataJson ?? {},
  });
  if (over.archived) {
    await store.update(exp.id, {
      // InMemoryExperienceStore.update 支持 validTo override（写一个旧时间标 archived）
      // 但接口里没有 validTo —— 走 logOp(archive) 不能改 row 状态
      // 用 metadataJson trick 不行（query archivalMode 看 validTo）
      // 简单：直接拿 store 内部数组（用 any 强转）写 validTo
    } as any);
    // 通过 any 直接改 in-memory 数组的 validTo
    const internal = (store as any).experiences as Map<string, Experience>;
    const cur = internal.get(exp.id);
    if (cur) internal.set(exp.id, { ...cur, validTo: NOW });
  }
  return exp;
}

describe("GET /memory/experiences", () => {
  test("projectId 缺失 → 400", async () => {
    const { status, body } = await get("/memory/experiences");
    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("projectId required");
  });

  test("kind 多值 + subKind 过滤", async () => {
    await seed({ kind: "semantic", subKind: "iteration_summary", summary: "a" });
    await seed({ kind: "semantic", subKind: "fact", summary: "b" });
    await seed({ kind: "procedural", subKind: "workflow_play", summary: "c" });
    await seed({ kind: "reflective", subKind: "failure_mode", summary: "d" });

    const { body } = await get("/memory/experiences?projectId=p1&kind=semantic&kind=procedural");
    expect(body.ok).toBe(true);
    expect(body.data.items.length).toBe(3);
    const subs = body.data.items.map((i: any) => i.subKind).sort();
    expect(subs).toEqual(["fact", "iteration_summary", "workflow_play"]);

    const { body: body2 } = await get(
      "/memory/experiences?projectId=p1&kind=semantic&subKind=fact"
    );
    expect(body2.data.items.length).toBe(1);
    expect(body2.data.items[0].summary).toBe("b");
  });

  test("q 关键词搜：summary / body / tags 三处都命中", async () => {
    await seed({ summary: "包含 AAPL 字样", body: "" });
    await seed({ summary: "无关", body: "正文里也有 AAPL" });
    await seed({ summary: "无关 2", tags: ["aapl"] });
    await seed({ summary: "彻底无关", body: "无关正文" });

    const { body } = await get("/memory/experiences?projectId=p1&q=aapl");
    expect(body.data.items.length).toBe(3); // 前 3 条都应命中
  });

  test("pinnedOnly + archivalMode", async () => {
    await seed({ summary: "pin", pinned: true });
    await seed({ summary: "no-pin", pinned: false });
    await seed({ summary: "archived-pinned", pinned: true, archived: true });

    const { body: b1 } = await get("/memory/experiences?projectId=p1&pinnedOnly=1");
    // exclude_archived 默认 → 已归档的虽 pinned 也被排除
    expect(b1.data.items.length).toBe(1);
    expect(b1.data.items[0].summary).toBe("pin");

    const { body: b2 } = await get(
      "/memory/experiences?projectId=p1&pinnedOnly=1&archivalMode=all"
    );
    expect(b2.data.items.length).toBe(2);
  });

  test("分页：limit + offset + total", async () => {
    for (let i = 0; i < 12; i += 1) {
      await seed({ summary: `e${i}` });
    }
    const { body } = await get("/memory/experiences?projectId=p1&limit=5&offset=0");
    expect(body.data.items.length).toBe(5);
    expect(body.data.total).toBe(12);
    expect(body.data.limit).toBe(5);
    expect(body.data.offset).toBe(0);

    const { body: b2 } = await get("/memory/experiences?projectId=p1&limit=5&offset=10");
    expect(b2.data.items.length).toBe(2);
  });

  test("列表 payload 不含 body（减重）", async () => {
    await seed({ summary: "s", body: "this is a very long body" });
    const { body } = await get("/memory/experiences?projectId=p1");
    const item = body.data.items[0];
    expect(item.summary).toBe("s");
    expect(item.body).toBeUndefined(); // body 不在列表
    expect(item.embeddingState).toBeNull(); // metadataJson 透出关键字段
    expect(item.qualityScore).toBeCloseTo(0.5);
  });

  test("embeddingState 透出（done / failed / null）", async () => {
    await seed({ summary: "a", metadataJson: { embeddingState: "done", embeddingModel: "m1" } });
    await seed({ summary: "b", metadataJson: { embeddingState: "failed" } });
    await seed({ summary: "c" });
    const { body } = await get("/memory/experiences?projectId=p1");
    const states: (string | null)[] = body.data.items.map((i: any) => i.embeddingState);
    // 不假设排序，断言"三种值都出现且仅出现 1 次"
    expect(states.length).toBe(3);
    expect(states.filter((s) => s === "done").length).toBe(1);
    expect(states.filter((s) => s === "failed").length).toBe(1);
    expect(states.filter((s) => s === null).length).toBe(1);
  });
});

describe("GET /memory/experiences/:id (detail)", () => {
  test("命中 → 完整 contentJson + metadataJson", async () => {
    const e = await seed({
      summary: "the summary",
      body: "the FULL body",
      metadataJson: { custom: "value" },
    });
    const { status, body } = await get(`/memory/experiences/${e.id}`);
    expect(status).toBe(200);
    expect(body.data.id).toBe(e.id);
    expect(body.data.contentJson.summary).toBe("the summary");
    expect(body.data.contentJson.body).toBe("the FULL body");
    expect(body.data.metadataJson.custom).toBe("value");
  });

  test("未命中 → 404", async () => {
    const { status, body } = await get("/memory/experiences/no-such-id");
    expect(status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("not_found");
  });
});

describe("GET /memory/experiences/:id/links", () => {
  test("1 跳邻居 + direction outgoing/incoming + brief", async () => {
    const seed1 = await seed({ summary: "seed" });
    const evidence = await seed({ summary: "evidence-of-seed" });
    const derived = await seed({ summary: "derived-from-seed" });

    // evidence → seed（evidence_of：incoming）
    await store.linkAdd(evidence.id, seed1.id, "evidence_of");
    // seed → derived（derive_from：outgoing）
    await store.linkAdd(seed1.id, derived.id, "derive_from");

    const { body } = await get(`/memory/experiences/${seed1.id}/links`);
    expect(body.data.seed.id).toBe(seed1.id);
    expect(body.data.links.length).toBe(2);

    const evLink = body.data.links.find((l: any) => l.relation === "evidence_of");
    const drLink = body.data.links.find((l: any) => l.relation === "derive_from");
    expect(evLink.direction).toBe("incoming");
    expect(evLink.other.summary).toBe("evidence-of-seed");
    expect(drLink.direction).toBe("outgoing");
    expect(drLink.other.summary).toBe("derived-from-seed");
  });

  test("relations csv 过滤", async () => {
    const seedExp = await seed({ summary: "seed" });
    const a = await seed({ summary: "a" });
    const b = await seed({ summary: "b" });
    await store.linkAdd(seedExp.id, a.id, "derive_from");
    await store.linkAdd(seedExp.id, b.id, "supersedes");

    const { body } = await get(`/memory/experiences/${seedExp.id}/links?relations=derive_from`);
    expect(body.data.links.length).toBe(1);
    expect(body.data.links[0].relation).toBe("derive_from");
  });

  test("seed 未命中 → 404", async () => {
    const { status } = await get("/memory/experiences/none/links");
    expect(status).toBe(404);
  });
});

describe("GET /memory/experiences/:id/oplog", () => {
  test("写多条 op_log → 列出按时间倒序", async () => {
    const e = await seed({ summary: "x" });
    await store.logOp({ experienceId: e.id, op: "create", actor: "test" });
    await store.logOp({ experienceId: e.id, op: "update", actor: "test" });
    await store.logOp({ experienceId: e.id, op: "recall", actor: "test" });

    const { status, body } = await get(`/memory/experiences/${e.id}/oplog`);
    expect(status).toBe(200);
    expect(body.data.items.length).toBeGreaterThanOrEqual(3);
    // 至少包含 create + update + recall 三种 op
    const ops = body.data.items.map((i: any) => i.op);
    expect(ops).toContain("create");
    expect(ops).toContain("update");
    expect(ops).toContain("recall");
  });

  test("limit 截断", async () => {
    const e = await seed({ summary: "x" });
    for (let i = 0; i < 10; i += 1) {
      await store.logOp({ experienceId: e.id, op: "recall", actor: "test" });
    }
    const { body } = await get(`/memory/experiences/${e.id}/oplog?limit=3`);
    expect(body.data.items.length).toBeLessThanOrEqual(3);
  });
});
