import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { runMigrations } from "../../../db/sqlite/migrate";
import { bootstrapProviders, _resetBootstrapForTests } from "../../provider/bootstrap";
import { factorService, FactorServiceError } from "../factor-service";

let projectId = "";

beforeAll(async () => {
  await runMigrations();
  _resetBootstrapForTests();
  await bootstrapProviders();
  const db = await getDb();
  const wid = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({ id: wid, name: "fs-ws", owner: "test" });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId: wid,
    name: "fs-proj",
    marketScope: "CN-A",
    status: "active",
  });
});

describe("FactorService", () => {
  test("register: 写库 + status=draft + 默认 provider 解析", async () => {
    const rec = await factorService.register({
      projectId,
      name: `mom_20_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close / Ref(close, 20) - 1",
      lang: "python",
      universe: "CN-A:hs300",
      horizon: 5,
    });
    expect(rec.id).toBeTruthy();
    expect(rec.status).toBe("draft");
    expect(rec.providerKey).toBe("python_inline");
    expect(rec.universe).toBe("CN-A:hs300");
  });

  test("register: 重名抛 duplicate_name", async () => {
    const name = `mom_dup_${randomUUID().slice(0, 6)}`;
    await factorService.register({
      projectId,
      name,
      category: "momentum",
      expr: "close",
    });
    await expect(
      factorService.register({
        projectId,
        name,
        category: "momentum",
        expr: "close",
      })
    ).rejects.toBeInstanceOf(FactorServiceError);
  });

  test("register: 含 banned token → 警告进 definition_json，注册仍成功", async () => {
    const rec = await factorService.register({
      projectId,
      name: `banned_${randomUUID().slice(0, 6)}`,
      category: "value",
      expr: "import os; close",
      lang: "python",
    });
    expect(rec.definition["providerValidationWarning"]).toBeDefined();
  });

  test("list: 按 category 过滤", async () => {
    const list = await factorService.list({ projectId, category: "momentum" });
    expect(list.length).toBeGreaterThan(0);
    for (const f of list) expect(f.category).toBe("momentum");
  });

  test("setStatus → active", async () => {
    const rec = await factorService.register({
      projectId,
      name: `q_${randomUUID().slice(0, 6)}`,
      category: "quality",
      expr: "close",
    });
    await factorService.setStatus(rec.id, "active");
    const fresh = await factorService.get(rec.id);
    expect(fresh.status).toBe("active");
  });

  test("evaluate: 跑 builtin factor_eval Provider 写入 factor_evaluation", async () => {
    const rec = await factorService.register({
      projectId,
      name: `eval_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
    });
    const values = Array.from({ length: 6 }, (_, i) => ({
      symbol: `S${i}`,
      date: "2026-05-01",
      value: i * 0.1,
    }));
    const future = values.map((v) => ({ ...v, value: (v.value ?? 0) * 0.6 + 0.01 }));
    const result = await factorService.evaluate({
      factorId: rec.id,
      values,
      futureReturns: future,
    });
    expect(result.evaluationId).toBeTruthy();
    expect(result.ic).toBeGreaterThan(0.9);
    expect(result.sampleSize).toBe(6);

    const logs = await factorService.listEvaluations(rec.id);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.factorId).toBe(rec.id);
  });

  test("compute: python_inline fallback 返回空 rows 但不抛错", async () => {
    const rec = await factorService.register({
      projectId,
      name: `compute_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close - Ref(close, 5)",
    });
    const res = await factorService.compute({
      factorId: rec.id,
      startDate: "2026-01-01",
      endDate: "2026-05-01",
      symbols: ["TEST"],
    });
    expect(res.meta.factorId).toBe(rec.id);
    expect(Array.isArray(res.rows)).toBe(true);
  });

  test("loadValues + valuesStats：手工 upsert 后能查回", async () => {
    const rec = await factorService.register({
      projectId,
      name: `store_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close",
      lang: "qlib_expr",
    });
    // 通过底层 store 写入（模拟 compute 已发生）
    const { factorValueStore } = await import("../factor-value-store");
    await factorValueStore.upsert({
      factorId: rec.id,
      rows: [
        { symbol: "AAA", date: "2026-04-01", value: 1.1 },
        { symbol: "AAA", date: "2026-04-02", value: 1.2 },
        { symbol: "BBB", date: "2026-04-01", value: 2.1 },
      ],
    });

    const all = await factorService.loadValues({ factorId: rec.id });
    expect(all.length).toBe(3);

    const aaaOnly = await factorService.loadValues({ factorId: rec.id, symbols: ["AAA"] });
    expect(aaaOnly.length).toBe(2);
    expect(aaaOnly.every((r) => r.symbol === "AAA")).toBe(true);

    const stats = await factorService.valuesStats(rec.id);
    expect(stats.rowCount).toBe(3);
    expect(stats.symbolCount).toBe(2);
    expect(stats.minDate).toBe("2026-04-01");
    expect(stats.maxDate).toBe("2026-04-02");
  });

  test("lang=qlib_expr 默认 providerKey=qlib_expr", async () => {
    const rec = await factorService.register({
      projectId,
      name: `qlib_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "Mean(close, 20)",
      lang: "qlib_expr",
    });
    expect(rec.lang).toBe("qlib_expr");
    expect(rec.providerKey).toBe("qlib_expr");
  });

  // ─── P0-2: dry-run 闸门 ────────────────────────────────────────────────────

  test("dry-run pass: 正常 qlib_expr 表达式注册成功，definition.dryRun.ok=true", async () => {
    const rec = await factorService.register({
      projectId,
      name: `dr_pass_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close / Ref(close, 20) - 1",
      lang: "qlib_expr",
      dryRun: true,
    });
    expect(rec.id).toBeTruthy();
    const dr = rec.definition["dryRun"] as Record<string, unknown> | undefined;
    expect(dr).toBeTruthy();
    expect(dr?.["ok"]).toBe(true);
    expect(typeof dr?.["sampleSize"]).toBe("number");
  });

  test("dry-run reject: 语法错的表达式被拒（不入库）", async () => {
    const name = `dr_synerr_${randomUUID().slice(0, 6)}`;
    await expect(
      factorService.register({
        projectId,
        name,
        category: "momentum",
        expr: "close +",
        lang: "qlib_expr",
        dryRun: true,
      })
    ).rejects.toThrow(/dry_run_failed: parse_error/);
    const after = await factorService.list({ projectId });
    expect(after.some((f) => f.name === name)).toBe(false);
  });

  test("dry-run reject: 表达式退化为常数 → degenerate_constant 被拒", async () => {
    // close / close == 1，恒为常数
    await expect(
      factorService.register({
        projectId,
        name: `dr_const_${randomUUID().slice(0, 6)}`,
        category: "momentum",
        expr: "close / close",
        lang: "qlib_expr",
        dryRun: true,
      })
    ).rejects.toThrow(/dry_run_failed: degenerate_constant/);
  });

  test("dry-run skipped: lang=python（非 qlib_expr）走 lang_unsupported 路径，注册仍成功", async () => {
    const rec = await factorService.register({
      projectId,
      name: `dr_skip_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "anything",
      lang: "python",
      dryRun: true,
    });
    const dr = rec.definition["dryRun"] as Record<string, unknown> | undefined;
    expect(dr?.["skipped"]).toBe(true);
    expect(String(dr?.["reason"] ?? "")).toContain("lang_unsupported");
  });
});
