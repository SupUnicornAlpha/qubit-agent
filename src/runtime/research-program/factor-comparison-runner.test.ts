import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import { factorDefinition, project, strategyVersion, workspace } from "../../db/sqlite/schema";
import { researchProgramRouter } from "../../routes/research-program.routes";
import { defaultDataDir } from "../app-paths";
import { backtestJobService } from "../backtest/backtest-job-service";
import { factorService } from "../factor/factor-service";
import { bootstrapProviders } from "../provider/bootstrap";
import { exportResearchEvidence, verifyEvidenceChecksum } from "./evidence";
import { factorComparisonRunner } from "./factor-comparison-runner";
import { buildIncrementalPreviewSnapshot } from "./fixtures/incremental-preview";
import { researchRunner } from "./runner";
import { researchProgramService } from "./service";
import { economicResultDigest, researchStrategyRunner } from "./strategy-runner";
import type { ResearchProtocolSpec } from "./types";
const wid = randomUUID();
const fixture = buildIncrementalPreviewSnapshot();
beforeAll(async () => {
  await runMigrations();
  await bootstrapProviders();
  (await getDb())
    .insert(workspace)
    .values({ id: wid, name: "incremental-test", owner: "test" })
    .run();
  const dir = join(defaultDataDir(), "market-snapshots");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${fixture.record.snapshot.snapshotId}.json`),
    JSON.stringify(fixture.record)
  );
});
async function setup(candidateExpr = "volume", maxAttempts = 4) {
  const pid = randomUUID();
  (await getDb())
    .insert(project)
    .values({ id: pid, workspaceId: wid, name: "incremental", marketScope: "US" })
    .run();
  const factor = async (name: string, expr: string) =>
    factorService.register({
      projectId: pid,
      name,
      category: "momentum",
      expr,
      lang: "qlib_expr",
      providerKey: "qlib_expr",
      universe: "US",
      dryRun: false,
    });
  const reference = await factor("reference", "close/Ref(close,5)-1");
  const candidate = await factor("candidate", candidateExpr);
  const spec: ResearchProtocolSpec = {
    hypothesis: "Synthetic incremental test",
    benchmark: "fixed rank basket",
    stoppingRule: "at budget",
    development: {
      datasetSnapshotId: fixture.record.snapshot.snapshotId,
      symbols: fixture.symbols,
      startDate: fixture.startDate,
      endDate: fixture.endDate,
    },
    evaluation: { method: "factor_rank_ic_v1", horizonDays: 1, groupCount: 3 },
    comparison: {
      method: "rank_blend_v1",
      references: [{ factorId: reference.id, direction: 1 }],
      candidateDirection: 1,
      candidateWeight: 0.25,
      costBps: 10,
    },
    budget: { maxAttempts, maxEvaluations: 0 },
  };
  const protocol = await researchRunner.createProtocol({ projectId: pid, spec });
  return { pid, reference, candidate, spec, protocol };
}
describe("controlled incremental comparison", () => {
  test("frozen strategy versions run real execution, survive factor edits, and reproduce with a new charged attempt", async () => {
    const { pid, candidate } = await setup("volume", 8);
    const comparison = await factorComparisonRunner.submit({
      projectId: pid,
      factorId: candidate.id,
      idempotencyKey: randomUUID(),
    });
    await factorComparisonRunner.waitForAttempt(comparison.id);
    const rules = {
      capital: 10000,
      topN: 3,
      rebalance: "daily" as const,
      commissionBps: 5,
      slippageBps: 5,
      minCommission: 1,
      maxVolumeParticipation: 0.05,
    };
    const [version, duplicate] = await Promise.all([
      researchStrategyRunner.create(pid, comparison.id, rules),
      researchStrategyRunner.create(pid, comparison.id, rules),
    ]);
    expect(version.id).toBe(duplicate.id);
    expect((await researchStrategyRunner.list(pid)).length).toBe(1);
    const key = randomUUID();
    const [first, concurrent] = await Promise.all([
      researchStrategyRunner.submit(pid, version.id, key),
      researchStrategyRunner.submit(pid, version.id, key),
    ]);
    expect(first).toEqual(concurrent);
    const job = await researchStrategyRunner.wait(first.jobId);
    expect(job.status).toBe("completed");
    expect(job.result?.error).toBeUndefined();
    expect(job.result?.trades.length ?? 0).toBeGreaterThan(0);
    expect(job.config.longShort).toBe(false);
    expect(job.config.costs.maxVolumeParticipation).toBe(0.05);
    expect(await researchStrategyRunner.submit(pid, version.id, key)).toEqual(first);
    (await getDb())
      .update(factorDefinition)
      .set({ expr: "Ref(close,-1)" })
      .where(eq(factorDefinition.id, candidate.id))
      .run();
    const replay = await researchStrategyRunner.submit(pid, version.id, randomUUID());
    const replayJob = await researchStrategyRunner.wait(replay.jobId);
    if (!job.result || !replayJob.result) throw new Error("missing backtest result");
    expect(economicResultDigest(job.result)).toBe(economicResultDigest(replayJob.result));
    expect((await researchProgramService.get(pid)).program?.usedAttempts).toBe(3);
    expect((await researchProgramService.get(pid)).program?.usedEvaluations).toBe(0);
    const revised = await researchStrategyRunner.create(pid, comparison.id, {
      ...rules,
      slippageBps: 10,
    });
    expect(revised.id).not.toBe(version.id);
    expect((await researchStrategyRunner.get(pid, version.id)).recipe.execution.slippageBps).toBe(
      5
    );
    await expect(researchStrategyRunner.get("wrong-project", version.id)).rejects.toThrow(
      "not_found"
    );
    const override = await researchProgramRouter.request(
      `/${pid}/strategies/${version.id}/backtests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: randomUUID(), capital: 1 }),
      }
    );
    expect(override.status).toBe(400);
    const artifact = await researchStrategyRunner.artifact(pid, version.id);
    expect(verifyEvidenceChecksum(artifact)).toBe(true);
    const tampered = structuredClone(artifact);
    tampered.evidence.version.recipe.execution.capital = 1;
    expect(verifyEvidenceChecksum(tampered)).toBe(false);
    expect(artifact.evidence.runs).toHaveLength(2);
    expect(artifact.evidence.runs[0]?.economicChecksum).toBe(
      artifact.evidence.runs[1]?.economicChecksum
    );
    expect(JSON.stringify(artifact)).not.toContain("barsBySymbol");
    // The legacy job endpoint must not bypass the frozen execution contract.
    await expect(
      backtestJobService.submit({
        strategyVersionId: version.id,
        idempotencyKey: randomUUID(),
        ...version.recipe.development,
        capital: 999999,
        signals: job.config.signals,
      })
    ).rejects.toThrow("override_forbidden");
    (await getDb())
      .update(strategyVersion)
      .set({ paramSchemaJson: { ...version.recipe, execution: { ...rules, capital: 50000 } } })
      .where(eq(strategyVersion.id, version.id))
      .run();
    await expect(researchStrategyRunner.submit(pid, version.id, randomUUID())).rejects.toThrow(
      "策略版本内容已变化"
    );
  });
  test("strategy gates reject missing evidence, oversized portfolios and paused or exhausted research", async () => {
    const { pid, candidate } = await setup("volume", 1);
    const rules = {
      capital: 10000,
      topN: 3,
      rebalance: "daily" as const,
      commissionBps: 5,
      slippageBps: 5,
      minCommission: 1,
      maxVolumeParticipation: 0.05,
    };
    await expect(researchStrategyRunner.create(pid, "missing", rules)).rejects.toThrow(
      "需要本项目"
    );
    const comparison = await factorComparisonRunner.submit({
      projectId: pid,
      factorId: candidate.id,
      idempotencyKey: randomUUID(),
    });
    await factorComparisonRunner.waitForAttempt(comparison.id);
    await expect(
      researchStrategyRunner.create(pid, comparison.id, { ...rules, topN: 100 })
    ).rejects.toThrow("top_n_exceeds");
    const version = await researchStrategyRunner.create(pid, comparison.id, rules);
    await expect(researchStrategyRunner.submit(pid, version.id, randomUUID())).rejects.toThrow();
    expect((await researchProgramService.get(pid)).program?.usedAttempts).toBe(1);
    await researchProgramService.setStatus(pid, "paused");
    await expect(researchStrategyRunner.create(pid, comparison.id, rules)).rejects.toThrow(
      "not_active"
    );
    await expect(researchStrategyRunner.submit(pid, version.id, randomUUID())).rejects.toThrow();
    expect((await researchProgramService.get(pid)).attempts).toHaveLength(1);
  });
  test("evidence rejects active attempts and reports corrupted snapshot without losing history", async () => {
    const { pid, candidate, protocol } = await setup();
    const pending = await researchProgramService.reserve({
      projectId: pid,
      protocolId: protocol.id,
      candidateId: candidate.id,
      candidateJson: {},
      requestJson: { operation: "incremental_compare" },
      kind: "factor_evaluate",
      idempotencyKey: randomUUID(),
    });
    await expect(exportResearchEvidence(pid, pending.id)).rejects.toThrow("尚未结束");
    await researchProgramService.cancel(pending.id);
    const attempt = await factorComparisonRunner.submit({
      projectId: pid,
      factorId: candidate.id,
      idempotencyKey: randomUUID(),
    });
    await factorComparisonRunner.waitForAttempt(attempt.id);
    const path = join(
      defaultDataDir(),
      "market-snapshots",
      `${fixture.record.snapshot.snapshotId}.json`
    );
    const raw = await readFile(path, "utf8");
    try {
      await writeFile(path, "{}");
      const bundle = await exportResearchEvidence(pid, attempt.id);
      expect(bundle.evidence.handoff.blockers).toContain("snapshot_missing_or_invalid");
      expect(bundle.evidence.currentSources.snapshotManifest).toBeNull();
      expect(bundle.evidence.attempt.status).toBe("completed");
      expect(bundle.evidence.searchHistory.entries).toHaveLength(2);
      expect(bundle.evidence.searchHistory.entries.some((a) => a.status === "cancelled")).toBe(
        true
      );
    } finally {
      await writeFile(path, raw);
    }
  });
  test("evidence freezes history, detects source drift and cannot grant trading eligibility", async () => {
    const { pid, candidate, reference } = await setup();
    const attempt = await factorComparisonRunner.submit({
      projectId: pid,
      factorId: candidate.id,
      idempotencyKey: randomUUID(),
    });
    await factorComparisonRunner.waitForAttempt(attempt.id);
    const response = await researchProgramRouter.request(`/${pid}/attempts/${attempt.id}/evidence`);
    expect(response.status).toBe(200);
    const bundle = await exportResearchEvidence(pid, attempt.id);
    expect(verifyEvidenceChecksum(bundle)).toBe(true);
    expect(bundle.evidence.handoff).toMatchObject({
      status: "ready_for_review",
      tradingEligible: false,
      independentValidation: "not_established",
    });
    expect(bundle.evidence.searchHistory.usedAttempts).toBe(1);
    expect(JSON.stringify(bundle)).not.toContain("barsByInstrument");
    const altered = structuredClone(bundle);
    altered.evidence.handoff.tradingEligible = true;
    expect(verifyEvidenceChecksum(altered)).toBe(false);
    expect(
      (await researchProgramRouter.request(`/another-project/attempts/${attempt.id}/evidence`))
        .status
    ).toBe(404);
    (await getDb())
      .update(factorDefinition)
      .set({ expr: "close" })
      .where(eq(factorDefinition.id, reference.id))
      .run();
    const changed = await exportResearchEvidence(pid, attempt.id);
    expect(changed.evidence.handoff.status).toBe("requires_repair");
    expect(changed.evidence.handoff.blockers).toContain(
      "live_factor_definitions_drifted_or_missing"
    );
    expect(changed.evidence.attempt.result).toEqual(bundle.evidence.attempt.result);
    expect((await researchProgramService.get(pid)).program?.usedAttempts).toBe(1);
  });
  test("failed comparison evidence retains failure without manufacturing validation", async () => {
    const { pid, candidate } = await setup("Ref(close,-1)");
    const attempt = await factorComparisonRunner.submit({
      projectId: pid,
      factorId: candidate.id,
      idempotencyKey: randomUUID(),
    });
    await factorComparisonRunner.waitForAttempt(attempt.id);
    const bundle = await exportResearchEvidence(pid, attempt.id);
    expect(bundle.evidence.attempt.status).toBe("failed");
    expect(bundle.evidence.handoff.blockers).toContain("comparison_not_completed");
    expect(bundle.evidence.attempt.error).toBeTruthy();
    expect(verifyEvidenceChecksum(bundle)).toBe(true);
  });
  test("REST preregisters frozen references, computes real evidence, and consumes one development attempt", async () => {
    const { pid, candidate, reference, protocol } = await setup();
    const input = { factorId: candidate.id, idempotencyKey: randomUUID() };
    const request = () =>
      researchProgramRouter.request(`/${pid}/comparisons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    const [a, b] = await Promise.all([request(), request()]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const first = (await a.json()) as { data: { id: string } };
    const second = (await b.json()) as { data: { id: string } };
    expect(first.data.id).toBe(second.data.id);
    const result = await factorComparisonRunner.waitForAttempt(first.data.id);
    expect(result.status).toBe("completed");
    expect(result.resultJson).toMatchObject({
      version: "factor-incremental-v1",
      scope: "development_only",
      verdict: "worth_validation",
      dataQualification: "research_only",
    });
    expect(result.requestJson).toMatchObject({
      operation: "incremental_compare",
      references: [{ id: reference.id, expr: reference.expr }],
    });
    expect(protocol.spec.comparison?.references[0]?.fingerprint).toMatch(/^sha256:/);
    const detail = await researchProgramService.get(pid);
    expect(detail.program?.usedAttempts).toBe(1);
    expect(detail.program?.usedEvaluations).toBe(0);
  });
  test("idempotency cannot cross ordinary evaluation and incremental comparison", async () => {
    const { pid, candidate } = await setup();
    const key = randomUUID();
    const attempt = await factorComparisonRunner.submit({
      projectId: pid,
      factorId: candidate.id,
      idempotencyKey: key,
    });
    await factorComparisonRunner.waitForAttempt(attempt.id);
    await expect(
      researchRunner.submitFactor({
        projectId: pid,
        factorId: candidate.id,
        kind: "factor_evaluate",
        idempotencyKey: key,
      })
    ).rejects.toThrow("idempotency_conflict");
    const old = await researchRunner.submitFactor({
      projectId: pid,
      factorId: candidate.id,
      kind: "factor_evaluate",
      idempotencyKey: "ordinary",
    });
    await researchRunner.waitForAttempt(old.id);
    await expect(
      factorComparisonRunner.submit({
        projectId: pid,
        factorId: candidate.id,
        idempotencyKey: "ordinary",
      })
    ).rejects.toThrow("idempotency_conflict");
  });
  test("future-dependent candidate fails and still consumes its reservation", async () => {
    const { pid, candidate } = await setup("Ref(close,-1)", 1);
    const attempt = await factorComparisonRunner.submit({
      projectId: pid,
      factorId: candidate.id,
      idempotencyKey: randomUUID(),
    });
    expect((await factorComparisonRunner.waitForAttempt(attempt.id)).status).toBe("failed");
    await expect(
      factorComparisonRunner.submit({
        projectId: pid,
        factorId: candidate.id,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow("budget_exhausted");
  });
  test("changed reference versions cannot silently replace the frozen baseline", async () => {
    const { pid, candidate, reference } = await setup();
    (await getDb())
      .update(factorDefinition)
      .set({ expr: "volume" })
      .where(eq(factorDefinition.id, reference.id))
      .run();
    await expect(
      factorComparisonRunner.submit({
        projectId: pid,
        factorId: candidate.id,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow("对照因子内容已变化");
    expect((await researchProgramService.get(pid)).program?.usedAttempts).toBe(0);
  });
  test("cross-project candidates, injected methods and self-reference are rejected", async () => {
    const a = await setup();
    const b = await setup();
    await expect(
      factorComparisonRunner.submit({
        projectId: a.pid,
        factorId: b.candidate.id,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow("project_mismatch");
    await expect(
      factorComparisonRunner.submit({
        projectId: a.pid,
        factorId: a.reference.id,
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow("自身");
    const response = await researchProgramRouter.request(`/${a.pid}/comparisons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factorId: a.candidate.id,
        idempotencyKey: randomUUID(),
        candidateWeight: 0.5,
      }),
    });
    expect(response.status).toBe(400);
  });
  test("method revision preserves budget/history and binds new reference versions", async () => {
    const { pid, candidate, spec } = await setup();
    const attempt = await factorComparisonRunner.submit({
      projectId: pid,
      factorId: candidate.id,
      idempotencyKey: randomUUID(),
    });
    await factorComparisonRunner.waitForAttempt(attempt.id);
    const comparison = spec.comparison;
    if (!comparison) throw new Error("fixture");
    const updated = await researchRunner.createProtocol({
      projectId: pid,
      spec: { ...spec, comparison: { ...comparison, costBps: 20 } },
    });
    expect(updated.version).toBe(2);
    const detail = await researchProgramService.get(pid);
    expect(detail.program?.usedAttempts).toBe(1);
    expect(detail.attempts[0]?.protocolId).not.toBe(updated.id);
  });
});
