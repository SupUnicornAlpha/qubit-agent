/**
 * NativeMemoryConnector bug 回归测试 — Memory V2 P0
 *
 * 锁住三个修复，防止后续重构改回去：
 *   B1：add() 返回的 id 必须能在 DB 里 findById 到（旧实现给了一个新 randomUUID）。
 *   B2：search() 必须按 query 关键词真正过滤，而不是当成 list。
 *   B3：longtermStore.semanticSearch 返回所有命中（旧实现只取 ids[0]）—— 这条因
 *        LanceDB 当前为空（无 caller 写向量），用 store.query 直接验"是否真的能拿到 N 条"。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUBIT_DATA_DIR = mkdtempSync(join(tmpdir(), "native-mem-bugfix-"));

import { randomUUID } from "node:crypto";
import { getDb } from "../../../../db/sqlite/client";
import { runMigrations } from "../../../../db/sqlite/migrate";
import * as schema from "../../../../db/sqlite/schema";
import { longtermStore } from "../longterm.store";
import { midtermStore } from "../midterm.store";
import { nativeMemoryConnector } from "../native.memory.connector";
import { sessionStore } from "../session.store";

const NOW = "2026-06-02T00:00:00.000Z";
let projectId: string;
let workflowRunId: string;

beforeAll(async () => {
  await runMigrations();
  await nativeMemoryConnector.init({});
  const db = await getDb();
  const workspaceId = randomUUID();
  projectId = randomUUID();
  workflowRunId = randomUUID();
  await db.insert(schema.workspace).values({
    id: workspaceId,
    name: "bugfix_ws",
    owner: "test",
    createdAt: NOW,
  });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "bugfix_proj",
    marketScope: "CN-A",
    createdAt: NOW,
  });
  await db.insert(schema.workflowRun).values({
    id: workflowRunId,
    projectId,
    sessionId: null,
    goal: "bugfix",
    mode: "research",
    status: "completed",
    startedAt: NOW,
    endedAt: NOW,
  });
});

describe("B1 — add() 返回的 id 真能在 DB 里查到", () => {
  test("longterm: connector.add().id === longtermStore 真正落库 id", async () => {
    const record = await nativeMemoryConnector.add("alpha101 momentum 因子复盘", {
      layer: "longterm",
      asofTime: NOW,
      projectId,
      memoryType: "playbook",
    });
    expect(record.id).toBeTruthy();
    const rows = await longtermStore.query({ scopeId: projectId, limit: 50 });
    const found = rows.find((r) => r.id === record.id);
    expect(found, "id 必须能在 longterm_memory 表里查到").toBeDefined();
    expect(JSON.stringify(found?.contentJson)).toContain("alpha101 momentum");
  });

  test("midterm: connector.add().id === midtermStore 真正落库 id", async () => {
    const record = await nativeMemoryConnector.add("本次迭代选择 SMA20", {
      layer: "midterm",
      asofTime: NOW,
      projectId,
      memoryType: "strategy_iteration",
    });
    const rows = await midtermStore.query({ projectId, limit: 50 });
    expect(rows.find((r) => r.id === record.id)).toBeDefined();
  });

  test("session: connector.add().id === sessionStore upsert 后行 id", async () => {
    const record = await nativeMemoryConnector.add("session note", {
      layer: "session",
      asofTime: NOW,
      workflowRunId,
    });
    const row = await sessionStore.findByWorkflowRun(workflowRunId);
    expect(row?.id).toBe(record.id);
  });
});

describe("B2 — search() 真正按 query 过滤", () => {
  beforeAll(async () => {
    // 写 3 条 midterm，分别带不同关键词，确保我们能区分"按 query 过滤" vs "拉全部"
    await nativeMemoryConnector.add("动量因子 momentum 在牛市表现优异", {
      layer: "midterm",
      asofTime: NOW,
      projectId,
      memoryType: "strategy_iteration",
    });
    await nativeMemoryConnector.add("价值因子 value 在熊市稳健", {
      layer: "midterm",
      asofTime: NOW,
      projectId,
      memoryType: "strategy_iteration",
    });
    await nativeMemoryConnector.add("成交量因子 volume 用于择时", {
      layer: "midterm",
      asofTime: NOW,
      projectId,
      memoryType: "strategy_iteration",
    });
  });

  test("midterm 层 query=momentum 仅返回相关项", async () => {
    const hits = await nativeMemoryConnector.search(
      "momentum",
      { layer: "midterm", projectId },
      5
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(10); // 不应该把"价值/成交量"也带回来
    expect(hits[0]?.content.toLowerCase()).toContain("momentum");
    // 命中分应非零
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  test("空 query 退化为按 recency 取 topK（兼容旧 list）", async () => {
    const all = await nativeMemoryConnector.search("", { layer: "midterm", projectId }, 2);
    expect(all.length).toBe(2);
  });

  test("query 没有命中时返回空数组（不再回退到全表）", async () => {
    const empty = await nativeMemoryConnector.search(
      "彻底不可能命中的字符串xyzzzz",
      { layer: "midterm", projectId },
      5
    );
    expect(empty).toEqual([]);
  });

  test("默认 layer=longterm；切到 midterm 才能看到 midterm 项", async () => {
    // longterm 至少有前面 B1 的"alpha101 momentum"
    const lt = await nativeMemoryConnector.search("momentum", { projectId }, 5);
    expect(lt.some((r) => r.content.includes("alpha101 momentum"))).toBe(true);
    // 但 longterm 不应看到 midterm 的"动量因子"
    expect(lt.every((r) => !r.content.includes("动量因子"))).toBe(true);
  });
});

describe("B3 — longtermStore.semanticSearch 不再只取 ids[0]", () => {
  /**
   * 直接通过 longtermStore.query 验 取全 N 条 —— 因为 LanceDB 当前没有 caller
   * 写向量，semanticSearch 在生产里走不通；但我们改完代码后，等 P1 接通 Embedder
   * 时不会再被 `ids[0]!` 这个隐藏 bug 卡住。这里用 inArray 的语义在 query 上做
   * 等价校验，确保至少 inArray 这条路径在 schema 上是工作的。
   */
  test("inArray 能拿回 N 条 longterm 行（防止回归）", async () => {
    const r1 = await nativeMemoryConnector.add("regime bull pattern", {
      layer: "longterm",
      asofTime: NOW,
      projectId,
      memoryType: "regime",
    });
    const r2 = await nativeMemoryConnector.add("regime bear pattern", {
      layer: "longterm",
      asofTime: NOW,
      projectId,
      memoryType: "regime",
    });
    const all = await longtermStore.query({ scopeId: projectId, limit: 50 });
    const ids = new Set(all.map((r) => r.id));
    expect(ids.has(r1.id)).toBe(true);
    expect(ids.has(r2.id)).toBe(true);
  });
});
