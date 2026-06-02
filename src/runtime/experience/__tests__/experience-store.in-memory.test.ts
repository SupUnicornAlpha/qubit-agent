/**
 * InMemoryExperienceStore 行为单测 — Memory V2 P0
 *
 * 内存实现是给 5 个 pipe 的单测准备的，必须与 SqliteExperienceStore 保持
 * 同一份契约。本测试覆盖：
 *   - insert 默认值 / pinned / definitionId null
 *   - update 仅替换传入字段（undefined 不清空）
 *   - query 按 kind / scope / definitionId / archivalMode / anyTags 过滤
 *   - query orderBy 三种排序
 *   - linkAdd 幂等 + 禁止 self-link
 *   - linkExpand maxDepth=1 / =2 / relations 过滤
 *   - logOp / listOps 顺序保持
 *
 * 不联 DB；运行 < 50ms。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { InMemoryExperienceStore } from "../experience-store";

const NOW = "2026-06-02T00:00:00.000Z";

let store: InMemoryExperienceStore;

beforeEach(() => {
  store = new InMemoryExperienceStore();
});

describe("InMemoryExperienceStore — insert", () => {
  test("默认值填充正确", async () => {
    const e = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "proj1",
      contentJson: { summary: "hello" },
      validFrom: NOW,
    });
    expect(e.id).toBeTruthy();
    expect(e.subKind).toBe("");
    expect(e.visibility).toBe("project_shared");
    expect(e.qualityScore).toBe(0.5);
    expect(e.useCount).toBe(0);
    expect(e.pinned).toBe(false);
    expect(e.definitionId).toBeNull();
    expect(e.tagsJson).toEqual([]);
    expect(e.validTo).toBeNull();
    expect(e.decayAt).toBeNull();
  });

  test("reflective + agent_private + definitionId 都尊重输入", async () => {
    const e = await store.insert({
      kind: "reflective",
      subKind: "failure_mode",
      scope: "project",
      scopeId: "proj1",
      definitionId: "def-research",
      visibility: "agent_private",
      contentJson: { summary: "tool foo 连续超时" },
      validFrom: NOW,
      tagsJson: ["tool:foo", "category:timeout"],
      qualityScore: 0.7,
      pinned: true,
    });
    expect(e.kind).toBe("reflective");
    expect(e.subKind).toBe("failure_mode");
    expect(e.visibility).toBe("agent_private");
    expect(e.definitionId).toBe("def-research");
    expect(e.tagsJson).toEqual(["tool:foo", "category:timeout"]);
    expect(e.qualityScore).toBe(0.7);
    expect(e.pinned).toBe(true);
  });
});

describe("InMemoryExperienceStore — update", () => {
  test("仅替换传入字段；其它字段保持", async () => {
    const e = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "a" },
      validFrom: NOW,
      qualityScore: 0.5,
      pinned: false,
    });
    const updated = await store.update(e.id, { qualityScore: 0.9 });
    expect(updated.qualityScore).toBe(0.9);
    expect(updated.contentJson.summary).toBe("a"); // 未传，不动
    expect(updated.pinned).toBe(false);
    expect(updated.updatedAt >= e.updatedAt).toBe(true);
  });

  test("update 不存在的 id 抛错", async () => {
    await expect(store.update("nope", { pinned: true })).rejects.toThrow(/not found/);
  });
});

describe("InMemoryExperienceStore — query", () => {
  beforeEach(async () => {
    // 准备 5 条数据，覆盖多种 kind / visibility / scope
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "fact A" },
      validFrom: "2026-06-01T00:00:00.000Z",
      qualityScore: 0.9,
      tagsJson: ["alpha"],
    });
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "fact B" },
      validFrom: "2026-06-02T00:00:00.000Z",
      qualityScore: 0.6,
      tagsJson: ["beta"],
    });
    await store.insert({
      kind: "reflective",
      subKind: "failure_mode",
      scope: "project",
      scopeId: "p1",
      definitionId: "def-A",
      visibility: "agent_private",
      contentJson: { summary: "A's lesson" },
      validFrom: "2026-06-02T01:00:00.000Z",
      tagsJson: ["alpha", "beta"],
    });
    await store.insert({
      kind: "procedural",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "skill X" },
      validFrom: "2026-06-02T02:00:00.000Z",
      qualityScore: 0.4,
    });
    // 已 supersede 的（validTo != null）
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p1",
      contentJson: { summary: "fact C (deprecated)" },
      validFrom: "2026-05-01T00:00:00.000Z",
      validTo: "2026-06-01T00:00:00.000Z",
    });
  });

  test("按 kind 单值过滤", async () => {
    const rows = await store.query({ scopeId: "p1", kind: "semantic" });
    // 默认 exclude_archived → 剔除 fact C
    expect(rows.map((r) => r.contentJson.summary)).toEqual(["fact B", "fact A"]);
  });

  test("按 kind 多值过滤", async () => {
    const rows = await store.query({
      scopeId: "p1",
      kind: ["semantic", "reflective"],
    });
    expect(rows.length).toBe(3);
  });

  test("按 definitionId 过滤 reflective 隔离场景", async () => {
    const rows = await store.query({ scopeId: "p1", definitionId: "def-A" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.kind).toBe("reflective");
  });

  test("archivalMode=only_archived 仅看 fact C", async () => {
    const rows = await store.query({ scopeId: "p1", archivalMode: "only_archived" });
    expect(rows.length).toBe(1);
    expect(rows[0]?.contentJson.summary).toBe("fact C (deprecated)");
  });

  test("anyTags 命中任意一个就返回", async () => {
    const rows = await store.query({ scopeId: "p1", anyTags: ["alpha"] });
    // fact A (alpha), reflective (alpha+beta) → 2
    expect(rows.length).toBe(2);
  });

  test("orderBy=quality_desc", async () => {
    const rows = await store.query({
      scopeId: "p1",
      kind: ["semantic", "procedural"],
      orderBy: "quality_desc",
    });
    expect(rows[0]?.qualityScore).toBe(0.9);
    expect(rows[rows.length - 1]?.qualityScore).toBe(0.4);
  });

  test("orderBy=valid_from_desc 默认", async () => {
    const rows = await store.query({ scopeId: "p1", kind: "semantic" });
    const v0 = rows[0]?.validFrom ?? "";
    const v1 = rows[1]?.validFrom ?? "";
    expect(v0 > v1).toBe(true);
  });
});

describe("InMemoryExperienceStore — links", () => {
  test("linkAdd 幂等", async () => {
    const a = await store.insert({
      kind: "episodic",
      scope: "workflow",
      scopeId: "wf1",
      contentJson: { summary: "step trail" },
      validFrom: NOW,
    });
    const b = await store.insert({
      kind: "reflective",
      scope: "project",
      scopeId: "p",
      definitionId: "def-x",
      visibility: "agent_private",
      contentJson: { summary: "lesson" },
      validFrom: NOW,
    });
    const l1 = await store.linkAdd(b.id, a.id, "derive_from");
    const l2 = await store.linkAdd(b.id, a.id, "derive_from");
    expect(l1.id).toBe(l2.id);
  });

  test("禁止 self-link", async () => {
    const a = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "x" },
      validFrom: NOW,
    });
    await expect(store.linkAdd(a.id, a.id, "derive_from")).rejects.toThrow();
  });

  test("linkExpand maxDepth=1 仅返回直接邻居", async () => {
    const a = await store.insert({
      kind: "episodic",
      scope: "workflow",
      scopeId: "wf1",
      contentJson: { summary: "A" },
      validFrom: NOW,
    });
    const b = await store.insert({
      kind: "reflective",
      scope: "project",
      scopeId: "p",
      definitionId: "d",
      visibility: "agent_private",
      contentJson: { summary: "B" },
      validFrom: NOW,
    });
    const c = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "C" },
      validFrom: NOW,
    });
    await store.linkAdd(a.id, b.id, "summarize_to");
    await store.linkAdd(b.id, c.id, "evidence_of");

    const depth1 = await store.linkExpand({ seedIds: [a.id], maxDepth: 1 });
    expect(depth1.map((r) => r.contentJson.summary)).toEqual(["B"]);

    const depth2 = await store.linkExpand({ seedIds: [a.id], maxDepth: 2 });
    expect(depth2.map((r) => r.contentJson.summary).sort()).toEqual(["B", "C"]);
  });

  test("linkExpand relations 过滤", async () => {
    const a = await store.insert({
      kind: "episodic",
      scope: "workflow",
      scopeId: "wf",
      contentJson: { summary: "A" },
      validFrom: NOW,
    });
    const b = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "B" },
      validFrom: NOW,
    });
    const c = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "C" },
      validFrom: NOW,
    });
    await store.linkAdd(a.id, b.id, "summarize_to");
    await store.linkAdd(a.id, c.id, "evidence_of");

    const only = await store.linkExpand({
      seedIds: [a.id],
      relations: ["summarize_to"],
    });
    expect(only.length).toBe(1);
    expect(only[0]?.contentJson.summary).toBe("B");
  });
});

describe("InMemoryExperienceStore — op log", () => {
  test("logOp + listOps 顺序保持", async () => {
    const e = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: "p",
      contentJson: { summary: "x" },
      validFrom: NOW,
    });
    await store.logOp({ experienceId: e.id, op: "create", actor: "extractor" });
    await store.logOp({
      experienceId: e.id,
      op: "recall",
      actor: "reason",
      workflowRunId: "wf-1",
    });
    await store.logOp({
      experienceId: e.id,
      op: "execute",
      actor: "act",
      workflowRunId: "wf-1",
      outcome: "success",
    });
    const ops = await store.listOps(e.id);
    expect(ops.map((o) => o.op)).toEqual(["create", "recall", "execute"]);
    expect(ops[2]?.outcome).toBe("success");
  });
});
