import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import * as schema from "../../../db/sqlite/schema";
import { _resetBootstrapForTests, bootstrapProviders } from "../../provider/bootstrap";
import { ALPHA_TEMPLATES } from "../alpha-templates";
import { DiscoveryError, discoveryService } from "../discovery-service";
import { GpGenerator } from "../gp-generator";

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
    expect(job.candidateAudit.length).toBeGreaterThanOrEqual(job.candidates.length);
    expect(job.candidateAudit.every((candidate) => candidate.discoveryDecision)).toBe(true);
    // FDR 结果必须与候选一同返回；通过校正的候选优先，其余再按 |IC| 排序。
    expect(job.multipleTesting?.method).toBe("benjamini_hochberg");
    expect(job.multipleTesting?.hypothesisCount).toBeGreaterThanOrEqual(job.candidates.length);
    for (let i = 1; i < job.candidates.length; i++) {
      const previous = job.candidates[i - 1];
      const current = job.candidates[i];
      if (!previous || !current) throw new Error("expected adjacent candidates");
      expect(Number((previous.metrics.adjustedPValue ?? 1) <= 0.05)).toBeGreaterThanOrEqual(
        Number((current.metrics.adjustedPValue ?? 1) <= 0.05)
      );
      if (
        Number((previous.metrics.adjustedPValue ?? 1) <= 0.05) ===
        Number((current.metrics.adjustedPValue ?? 1) <= 0.05)
      ) {
        expect(previous.metrics.score).toBeGreaterThanOrEqual(current.metrics.score);
      }
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
    ).rejects.toThrow(/unsupported_kind_rule_llm/);
  });

  // ─── P0-4: factor_llm ──────────────────────────────────────────────────────

  test("factor_llm: 传 expressions[] 走 evaluateOne 闸门，IC 按 |IC| 排序", async () => {
    const job = await discoveryService.submitAndRun({
      projectId,
      kind: "factor_llm",
      symbols: ["SYN1", "SYN2", "SYN3", "SYN4"],
      startDate: "2026-01-01",
      endDate: "2026-04-30",
      horizonDays: 5,
      topK: 3,
      expressions: [
        "close / Ref(close, 5) - 1",
        "Mean(close, 10) / Mean(close, 30) - 1",
        "(high - low) / close",
        "Rank(volume / Mean(volume, 20))",
        "close - Ref(close, 1)",
      ],
    });
    expect(job.status).toBe("succeeded");
    expect(job.candidates.length).toBeGreaterThan(0);
    expect(job.candidates.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < job.candidates.length; i++) {
      const previous = job.candidates[i - 1];
      const current = job.candidates[i];
      if (!previous || !current) throw new Error("expected adjacent candidates");
      expect(previous.metrics.score).toBeGreaterThanOrEqual(current.metrics.score);
    }
    for (const c of job.candidates) expect(c.lang).toBe("qlib_expr");
  });

  test("factor_llm: expressions 为空 → validation_failed", async () => {
    await expect(
      discoveryService.submit({
        projectId,
        kind: "factor_llm",
        symbols: ["SYN1"],
        startDate: "2026-01-01",
        endDate: "2026-04-30",
        expressions: [],
      })
    ).rejects.toThrow(/expressions_required/);
  });

  test("factor_llm: 语法错的表达式会进 candidates 但带 error，不影响其它评估", async () => {
    const job = await discoveryService.submitAndRun({
      projectId,
      kind: "factor_llm",
      symbols: ["SYN1", "SYN2"],
      startDate: "2026-01-01",
      endDate: "2026-04-30",
      horizonDays: 5,
      topK: 5,
      expressions: ["close +", "close / Ref(close, 5) - 1"], // 1 错 1 对
    });
    expect(job.status).toBe("succeeded");
    // run() 里 sorted 把 error 过滤了 → topK 中只剩 1 个有效
    expect(job.candidates.every((c) => !c.error)).toBe(true);
    expect(
      job.candidateAudit.some((c) => c.error && c.discoveryDecision?.status === "rejected")
    ).toBe(true);
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
    const cand = job.candidates[0];
    if (!cand) throw new Error("expected shortlisted candidate");

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
    const lineage = fresh.definition.promotedFrom as Record<string, unknown> | undefined;
    expect(lineage).toBeDefined();
    expect(lineage?.discoveryJobId).toBe(job.id);
    expect(lineage?.candidateId).toBe(cand.id);
    expect(lineage?.ic).toBe(cand.metrics.ic);
    expect(lineage?.candidateTrials).toBe(job.candidateAudit.length);
    expect(factor.status).toBe("draft");
  });

  test("promoteCandidate cannot bypass factor admission by requesting active", async () => {
    const job = await discoveryService.submitAndRun({
      projectId,
      kind: "factor_alpha101",
      symbols: ["SYN1", "SYN2", "SYN3"],
      startDate: "2026-01-01",
      endDate: "2026-04-30",
      topK: 1,
    });
    const candidate = job.candidates[0];
    if (!candidate) throw new Error("expected shortlisted candidate");
    await expect(
      discoveryService.promoteCandidate(job.id, candidate.id, {
        name: `blocked_${randomUUID().slice(0, 6)}`,
        status: "active",
      })
    ).rejects.toThrow("discovery_promote_requires_draft");
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
