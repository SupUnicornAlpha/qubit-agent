/**
 * SqliteExperienceStore 集成测试 — Memory V2 P0
 *
 * 跑真实 bun:sqlite + drizzle，验证 4 张新表 migration 真的 apply 上、
 * 字段 round-trip 正确，且与 InMemoryExperienceStore 对外行为一致。
 *
 * 用 QUBIT_DATA_DIR 隔离到 .tmp 目录，运行后不污染主 datadir。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在 import db client 之前设置 QUBIT_DATA_DIR
process.env.QUBIT_DATA_DIR = mkdtempSync(join(tmpdir(), "experience-store-it-"));

import { randomUUID } from "node:crypto";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import * as schema from "../../../db/sqlite/schema";
import { SqliteExperienceStore } from "../experience-store";

const NOW = "2026-06-02T00:00:00.000Z";
let store: SqliteExperienceStore;
let projectId: string;
let workspaceId: string;

beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  workspaceId = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "exp_ws",
    owner: "test",
    createdAt: NOW,
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "exp_proj",
    marketScope: "CN-A",
    createdAt: NOW,
  });
  store = new SqliteExperienceStore();
});

describe("SqliteExperienceStore — round-trip 基础字段", () => {
  test("insert → findById 全字段一致（含 contentJson / tagsJson / metadata 三个 json 列）", async () => {
    const inserted = await store.insert({
      kind: "semantic",
      subKind: "fact",
      scope: "project",
      scopeId: projectId,
      contentJson: { summary: "fact A", body: "body text", custom: 123 },
      tagsJson: ["alpha", "beta"],
      validFrom: NOW,
      qualityScore: 0.77,
      metadataJson: { source: "test", nested: { a: 1 } },
    });
    expect(inserted.id).toBeTruthy();

    const found = await store.findById(inserted.id);
    expect(found).not.toBeNull();
    expect(found?.kind).toBe("semantic");
    expect(found?.subKind).toBe("fact");
    expect(found?.contentJson.summary).toBe("fact A");
    expect(found?.contentJson.body).toBe("body text");
    expect(found?.contentJson.custom).toBe(123);
    expect(found?.tagsJson).toEqual(["alpha", "beta"]);
    expect(found?.qualityScore).toBeCloseTo(0.77, 5);
    expect(found?.metadataJson.source).toBe("test");
    expect((found?.metadataJson.nested as { a: number }).a).toBe(1);
  });

  test("update 仅修改传入字段；contentJson 整体替换", async () => {
    const e = await store.insert({
      kind: "reflective",
      subKind: "failure_mode",
      scope: "project",
      scopeId: projectId,
      definitionId: null,
      visibility: "agent_private",
      contentJson: { summary: "orig" },
      validFrom: NOW,
    });
    const updated = await store.update(e.id, {
      contentJson: { summary: "new", body: "x" },
      qualityScore: 0.88,
    });
    expect(updated.contentJson.summary).toBe("new");
    expect(updated.contentJson.body).toBe("x");
    expect(updated.qualityScore).toBeCloseTo(0.88, 5);
    // 未改的字段保持
    expect(updated.kind).toBe("reflective");
    expect(updated.visibility).toBe("agent_private");
  });
});

describe("SqliteExperienceStore — query 与 IS NULL", () => {
  test("definitionId=null 过滤走 IS NULL 而非 =", async () => {
    const myProjId = randomUUID();
    const db = await getDb();
    await db.insert(schema.project).values({
      id: myProjId,
      workspaceId,
      name: "isnull_proj",
      marketScope: "CN-A",
      createdAt: NOW,
    });
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: myProjId,
      definitionId: null,
      contentJson: { summary: "shared" },
      validFrom: NOW,
    });
    await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: myProjId,
      definitionId: null,
      contentJson: { summary: "shared2" },
      validFrom: NOW,
    });

    const shared = await store.query({ scopeId: myProjId, definitionId: null });
    expect(shared.length).toBe(2);
  });
});

describe("SqliteExperienceStore — link & op_log", () => {
  test("linkAdd 唯一约束触发也能幂等读回", async () => {
    const a = await store.insert({
      kind: "episodic",
      scope: "workflow",
      scopeId: "wf-sqlite-1",
      contentJson: { summary: "A" },
      validFrom: NOW,
    });
    const b = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: projectId,
      contentJson: { summary: "B" },
      validFrom: NOW,
    });
    const l1 = await store.linkAdd(b.id, a.id, "derive_from", 0.8);
    const l2 = await store.linkAdd(b.id, a.id, "derive_from", 0.5);
    expect(l1.id).toBe(l2.id);
    // weight 不被第二次 add 改写（唯一冲突时不更新）
    expect(l1.weight).toBeCloseTo(0.8, 5);
  });

  test("linkExpand 真的能拿到邻居", async () => {
    const a = await store.insert({
      kind: "episodic",
      scope: "workflow",
      scopeId: "wf-sqlite-2",
      contentJson: { summary: "A2" },
      validFrom: NOW,
    });
    const b = await store.insert({
      kind: "reflective",
      scope: "project",
      scopeId: projectId,
      definitionId: null,
      visibility: "agent_private",
      contentJson: { summary: "B2" },
      validFrom: NOW,
    });
    await store.linkAdd(a.id, b.id, "summarize_to");

    const neighbors = await store.linkExpand({ seedIds: [a.id] });
    expect(neighbors.map((n) => n.contentJson.summary)).toContain("B2");
  });

  test("logOp + listOps round-trip", async () => {
    const e = await store.insert({
      kind: "semantic",
      scope: "project",
      scopeId: projectId,
      contentJson: { summary: "op test" },
      validFrom: NOW,
    });
    await store.logOp({ experienceId: e.id, op: "create", actor: "extractor" });
    await store.logOp({
      experienceId: e.id,
      op: "recall",
      actor: "reason",
      workflowRunId: null,
      metadataJson: { rank: 1 },
    });
    const ops = await store.listOps(e.id);
    expect(ops.length).toBe(2);
    expect(ops[0]?.op).toBe("create");
    expect(ops[1]?.metadataJson.rank).toBe(1);
  });
});
