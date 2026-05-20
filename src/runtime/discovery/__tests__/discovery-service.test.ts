import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { runMigrations } from "../../../db/sqlite/migrate";
import { _resetBootstrapForTests, bootstrapProviders } from "../../provider/bootstrap";
import { discoveryService, DiscoveryError } from "../discovery-service";
import { GpGenerator } from "../gp-generator";
import { ALPHA_TEMPLATES } from "../alpha-templates";

let projectId = "";

beforeAll(async () => {
  await runMigrations();
  _resetBootstrapForTests();
  await bootstrapProviders();
  const db = await getDb();
  const wid = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({ id: wid, name: "disc-ws", owner: "test" });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId: wid,
    name: "disc-proj",
    marketScope: "CN-A",
    status: "active",
  });
});

describe("GpGenerator", () => {
  test("同 seed 产出可复现", () => {
    const a = new GpGenerator({ seed: 42, maxDepth: 3 });
    const b = new GpGenerator({ seed: 42, maxDepth: 3 });
    const exprsA = a.generateUnique(10);
    const exprsB = b.generateUnique(10);
    expect(exprsA).toEqual(exprsB);
  });

  test("生成的表达式都能被 parser 解析", async () => {
    const { parse } = await import("../../provider/impls/factor/qlib-expr/parser");
    const g = new GpGenerator({ seed: 7, maxDepth: 3 });
    for (let i = 0; i < 30; i++) {
      const e = g.generate();
      expect(() => parse(e)).not.toThrow();
    }
  });
});

describe("ALPHA_TEMPLATES", () => {
  test("每个模板都能被解析", async () => {
    const { parse } = await import("../../provider/impls/factor/qlib-expr/parser");
    for (const t of ALPHA_TEMPLATES) {
      expect(() => parse(t.expr)).not.toThrow();
    }
  });
});

describe("DiscoveryService", () => {
  test("submit + run factor_alpha101：状态 pending → succeeded，候选有 IC 评估", async () => {
    const job = await discoveryService.submitAndRun({
      projectId,
      kind: "factor_alpha101",
      symbols: ["SYN1", "SYN2", "SYN3", "SYN4", "SYN5"], // 合成数据
      startDate: "2026-01-01",
      endDate: "2026-04-30", // 4 个月 → ~120 bars
      horizonDays: 5,
      topK: 5,
    });
    expect(job.status).toBe("succeeded");
    expect(job.candidates.length).toBeGreaterThan(0);
    expect(job.candidates.length).toBeLessThanOrEqual(5);
    // top K 应当按 |IC| 降序
    for (let i = 1; i < job.candidates.length; i++) {
      expect(job.candidates[i - 1]!.metrics.score).toBeGreaterThanOrEqual(
        job.candidates[i]!.metrics.score
      );
    }
    // 所有候选都有 sampleSize > 0
    for (const c of job.candidates) {
      expect(c.metrics.sampleSize).toBeGreaterThan(0);
    }
  });

  test("submit + run factor_gp：seed 可复现", async () => {
    const job1 = await discoveryService.submitAndRun({
      projectId,
      kind: "factor_gp",
      symbols: ["SYN1", "SYN2", "SYN3"],
      startDate: "2026-01-01",
      endDate: "2026-04-30",
      horizonDays: 5,
      topK: 5,
      candidateCount: 15,
      seed: 100,
    });
    const job2 = await discoveryService.submitAndRun({
      projectId,
      kind: "factor_gp",
      symbols: ["SYN1", "SYN2", "SYN3"],
      startDate: "2026-01-01",
      endDate: "2026-04-30",
      horizonDays: 5,
      topK: 5,
      candidateCount: 15,
      seed: 100,
    });
    expect(job1.status).toBe("succeeded");
    expect(job2.status).toBe("succeeded");
    expect(job1.candidates.map((c) => c.expr)).toEqual(job2.candidates.map((c) => c.expr));
  });

  test("symbols 为空 → validation_failed", async () => {
    await expect(
      discoveryService.submit({
        projectId,
        kind: "factor_alpha101",
        symbols: [],
        startDate: "2026-01-01",
        endDate: "2026-04-30",
      })
    ).rejects.toBeInstanceOf(DiscoveryError);
  });

  test("不支持的 kind → validation_failed", async () => {
    await expect(
      discoveryService.submit({
        projectId,
        kind: "rule_llm",
        symbols: ["AAA"],
        startDate: "2026-01-01",
        endDate: "2026-04-30",
      })
    ).rejects.toThrow(/unsupported_kind_for_m4/);
  });

  test("list 按 projectId 过滤", async () => {
    const rows = await discoveryService.list({ projectId });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.projectId).toBe(projectId);
  });

  test("promoteCandidate：把 alpha101 候选 promote 为正式 factor", async () => {
    const { factorService } = await import("../../factor/factor-service");
    const job = await discoveryService.submitAndRun({
      projectId,
      kind: "factor_alpha101",
      symbols: ["SYN1", "SYN2", "SYN3"],
      startDate: "2026-01-01",
      endDate: "2026-04-30",
      horizonDays: 5,
      topK: 3,
    });
    expect(job.candidates.length).toBeGreaterThan(0);
    const cand = job.candidates[0]!;

    const fName = `promoted_${randomUUID().slice(0, 6)}`;
    const factor = await discoveryService.promoteCandidate(job.id, cand.id, {
      name: fName,
      category: "momentum",
    });
    expect(factor.name).toBe(fName);
    expect(factor.expr).toBe(cand.expr);
    expect(factor.lang).toBe("qlib_expr");
    expect(factor.providerKey).toBe("qlib_expr");
    // 校验 definition 里保留了 lineage
    const fresh = await factorService.get(factor.id);
    const lineage = fresh.definition["promotedFrom"] as Record<string, unknown> | undefined;
    expect(lineage).toBeDefined();
    expect(lineage!["discoveryJobId"]).toBe(job.id);
    expect(lineage!["candidateId"]).toBe(cand.id);
    expect(lineage!["ic"]).toBe(cand.metrics.ic);
  });

  test("promoteCandidate：候选不存在 → validation_failed", async () => {
    const job = await discoveryService.submitAndRun({
      projectId,
      kind: "factor_alpha101",
      symbols: ["SYN1", "SYN2", "SYN3"],
      startDate: "2026-01-01",
      endDate: "2026-04-30",
    });
    await expect(
      discoveryService.promoteCandidate(job.id, "nonexistent_id", { name: "x" })
    ).rejects.toThrow(/candidate_not_found/);
  });
});
