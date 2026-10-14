import { buildMarketSnapshotRecord } from "../market/contracts/market-snapshot-service";
import { ResearchPaperWorker } from "./strategy-paper-worker";
import { SealedEvaluatorClient } from "./evaluator-client";
import { ResearchRunner } from "./runner";
import { evidenceDigest } from "./evidence-checksum";
import { strategyValidationReceiptSchema } from "./strategy-validation-types";
import { StrategyLifecycle, strategyLifecycle } from "./strategy-lifecycle";
import { strategyPaper, reconcileTraces } from "./strategy-paper";
import { manageResearchStrategy } from "./strategy-management";
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
async function setup(candidateExpr = "volume", maxAttempts = 4, maxEvaluations = 0) {
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
    budget: { maxAttempts, maxEvaluations },
  };
  const protocol = await researchRunner.createProtocol({ projectId: pid, spec });
  return { pid, reference, candidate, spec, protocol };
}
describe("controlled incremental comparison", () => {
  test("lifecycle keeps lineage, compares only like conditions, protects state and resumes causal paper execution", async () => {
    const { pid, candidate } = await setup("volume", 30);
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
    const version = await researchStrategyRunner.create(pid, comparison.id, rules);
    await expect(
      strategyLifecycle.transition(pid, version.id, {
        status: "review",
        reason: "test",
        expectedRevision: 0,
      })
    ).rejects.toThrow("evidence_required");
    const run = await researchStrategyRunner.submit(pid, version.id, randomUUID());
    await researchStrategyRunner.wait(run.jobId);
    const job = await backtestJobService.get(run.jobId);
    expect(job.result?.executionTrace).toHaveLength(220);
    const changed = await researchStrategyRunner.create(pid, comparison.id, {
      ...rules,
      slippageBps: 10,
    });
    const diff = await strategyLifecycle.compare(pid, version.id, changed.id);
    expect(diff.comparable).toBe(false);
    expect(diff.performance).toBeNull();
    expect(diff.diffs.some((d) => d.field === "execution.slippageBps")).toBe(true);
    expect((await strategyLifecycle.compare(pid, version.id, version.id)).comparable).toBe(true);
    let d = await strategyLifecycle.transition(pid, version.id, {
      status: "review",
      referenceAttemptId: run.attemptId!,
      reason: "ready for independent review",
      expectedRevision: 0,
    });
    expect(d.status).toBe("review");
    expect(d.source?.id).toBe(comparison.id);
    await expect(
      strategyLifecycle.transition(pid, version.id, {
        status: "archived",
        reason: "stale",
        expectedRevision: 0,
      })
    ).rejects.toThrow("刷新");
    await expect(
      manageResearchStrategy(pid, version.id, {
        action: "state",
        status: "validated",
        reason: "self declared",
        expectedRevision: d.revision,
      })
    ).rejects.toThrow();
    await expect(strategyLifecycle.plan(pid, version.id, d.revision)).rejects.toThrow(
      "not_configured"
    );
    await expect(strategyLifecycle.detail("other", version.id)).rejects.toThrow("not_found");
    const session = await strategyPaper.create(pid, version.id, run.attemptId!, d.revision);
    const input = { expectedCursor: null, idempotencyKey: randomUUID(), bars: 20 };
    const [a, b] = await Promise.all([
      strategyPaper.advance(pid, version.id, session.id, input),
      strategyPaper.advance(pid, version.id, session.id, input),
    ]);
    expect(a.id).toBe(b.id);
    const completed = await strategyPaper.wait(a.id);
    expect(completed.status).toBe("completed");
    const result = completed.resultJson as {
      cursor: string;
      differences: Array<{ status: string }>;
    };
    expect(result.differences).toHaveLength(20);
    expect(result.differences.every((r) => r.status === "matched")).toBe(true);
    // A new service reader restores cursor from SQLite rather than process-local sessions.
    const restored = (await strategyPaper.list(pid, version.id))[0]!;
    expect(restored.cursor).toBe(result.cursor);
    await expect(
      strategyPaper.advance(pid, version.id, session.id, { ...input, idempotencyKey: randomUUID() })
    ).rejects.toThrow("cursor_conflict");
    d = await strategyLifecycle.detail(pid, version.id);
    await strategyPaper.setStatus(pid, version.id, session.id, "paused", d.revision);
    await expect(
      strategyPaper.advance(pid, version.id, session.id, {
        expectedCursor: result.cursor,
        idempotencyKey: randomUUID(),
        bars: 20,
      })
    ).rejects.toThrow("not_running");
    d = await strategyLifecycle.detail(pid, version.id);
    await strategyPaper.setStatus(pid, version.id, session.id, "running", d.revision);
    const next = await strategyPaper.advance(pid, version.id, session.id, {
      expectedCursor: result.cursor,
      idempotencyKey: randomUUID(),
      bars: 20,
    });
    expect((await strategyPaper.wait(next.id)).status).toBe("completed");
    d = await strategyLifecycle.detail(pid, version.id);
    await strategyPaper.setStatus(pid, version.id, session.id, "running", d.revision, true);
    await new ResearchPaperWorker().tick();
    const automatic = (await strategyPaper.list(pid, version.id))[0]!.attempts[0]!;
    expect((await strategyPaper.wait(automatic.id)).status).toBe("completed");
    expect((await strategyPaper.list(pid, version.id))[0]?.cursor).not.toBe(result.cursor);
    const extended = buildIncrementalPreviewSnapshot(221);
    const raw = structuredClone(extended.record.barsByInstrument);
    const firstBar = raw[`US:${fixture.symbols[0]}`]![0]!;
    firstBar.volume += 1000;
    const revised = buildMarketSnapshotRecord({
      purpose: "research",
      asOf: extended.record.snapshot.asOf,
      instruments: fixture.symbols.map((symbol) => ({ symbol, venue: "US", assetClass: "equity" })),
      window: { start: fixture.startDate, end: extended.endDate },
      sources: [
        {
          provider: "synthetic-preview-only",
          feed: "synthetic-preview-only",
          upstreamFamily: "synthetic-preview-only",
        },
      ],
      timeframe: "1d",
      limit: 221,
      barsByInstrument: raw,
    });
    await writeFile(
      join(defaultDataDir(), "market-snapshots", `${revised.snapshot.snapshotId}.json`),
      JSON.stringify(revised)
    );
    const cursor = (await strategyPaper.list(pid, version.id))[0]!.cursor;
    const revisedStep = await strategyPaper.advance(pid, version.id, session.id, {
      expectedCursor: cursor,
      idempotencyKey: randomUUID(),
      bars: 20,
      snapshotId: revised.snapshot.snapshotId,
    });
    const rejected = await strategyPaper.wait(revisedStep.id);
    expect(rejected.status).toBe("failed");
    expect(rejected.error).toContain("paper_history_changed");
    expect((await strategyPaper.list(pid, version.id))[0]!.cursor).toBe(cursor);
    await new ResearchPaperWorker().tick();
    expect((await strategyPaper.list(pid, version.id))[0]!.status).toBe("paused");
    const trace = job.result!.executionTrace!;
    const altered = structuredClone(trace.slice(0, 1));
    altered[0]!.input = "changed";
    altered[0]!.fill = "changed";
    expect(reconcileTraces(trace, altered)[0]?.firstDifference).toBe("input");
    d = await strategyLifecycle.detail(pid, version.id);
    await strategyLifecycle.transition(pid, version.id, {
      status: "archived",
      reason: "archive with evidence retained",
      expectedRevision: d.revision,
    });
    await expect(researchStrategyRunner.submit(pid, version.id, randomUUID())).rejects.toThrow(
      "archived"
    );
    expect((await strategyLifecycle.detail(pid, version.id)).attempts.length).toBe(5);
    expect((await researchProgramService.get(pid)).program?.usedAttempts).toBe(6);
  });
  test("frozen validation plan binds receipts and quotas, cancellation wins, and unknown development provenance cannot promote", async () => {
    const { pid, candidate, spec } = await setup("volume", 12, 3);
    const descriptor = {
      id: "sealed-strategy-fixture",
      label: "Synthetic independent-service mock",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      maxEvaluations: 3,
      horizonDays: 1,
      groupCount: 3,
      datasetFingerprint: evidenceDigest("fixture-data"),
      strategyPolicy: {
        method: "us_daily_top_n_v1",
        benchmark: "equal_weight_daily",
        minObservations: 60,
        minTrades: 5,
        minExcessReturn: 0,
        maxDrawdown: 0.5,
      },
    };
    let release: (() => void) | undefined;
    let delay = false;
    let mismatch = false;
    const client = new SealedEvaluatorClient({
      url: "http://localhost:8790",
      token: "test-only-token",
      fetch: (async (url: string, init?: RequestInit) => {
        if (url.endsWith("/datasets")) return Response.json({ datasets: [descriptor] });
        if (delay)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        const request = JSON.parse(String(init?.body));
        return Response.json(
          strategyValidationReceiptSchema.parse({
            version: "sealed-strategy-v1",
            attemptId: request.attemptId,
            protocolFingerprint: request.protocolFingerprint,
            planFingerprint: request.planFingerprint,
            strategyFingerprint: mismatch ? evidenceDigest("wrong") : request.strategyFingerprint,
            datasetFingerprint: request.datasetFingerprint,
            policyFingerprint: request.policyFingerprint,
            status: "passed",
            metrics: {
              totalReturn: 0.2,
              benchmarkReturn: 0.1,
              maxDrawdown: 0.03,
              observations: 100,
              tradeCount: 50,
            },
            reasonCodes: ["synthetic_mock_for_boundary_test"],
            evaluatedAt: new Date().toISOString(),
          })
        );
      }) as typeof fetch,
    });
    await new ResearchRunner(client).createProtocol({
      projectId: pid,
      spec: { ...spec, evaluation: { ...spec.evaluation, sealedDatasetId: descriptor.id } },
    });
    const comparison = await factorComparisonRunner.submit({
      projectId: pid,
      factorId: candidate.id,
      idempotencyKey: randomUUID(),
    });
    await factorComparisonRunner.waitForAttempt(comparison.id);
    const version = await researchStrategyRunner.create(pid, comparison.id, {
      capital: 10000,
      topN: 3,
      rebalance: "daily",
      commissionBps: 5,
      slippageBps: 5,
      minCommission: 1,
      maxVolumeParticipation: 0.05,
    });
    const run = await researchStrategyRunner.submit(pid, version.id, randomUUID());
    await researchStrategyRunner.wait(run.jobId);
    const lifecycle = new StrategyLifecycle(client);
    const d = await lifecycle.transition(pid, version.id, {
      status: "review",
      referenceAttemptId: run.attemptId!,
      reason: "frozen test evidence",
      expectedRevision: 0,
    });
    const plan = await lifecycle.plan(pid, version.id, d.revision);
    const key = randomUUID();
    const attempt = await lifecycle.validate(pid, version.id, plan.id, key);
    expect((await lifecycle.wait(attempt.id)).status).toBe("completed");
    expect((await lifecycle.validate(pid, version.id, plan.id, key)).id).toBe(attempt.id);
    expect((await lifecycle.detail(pid, version.id)).status).toBe("review");
    expect(
      (await lifecycle.detail(pid, version.id)).checklist.find((c) => c.code === "verified_data")
        ?.passed
    ).toBe(false);
    expect((await researchProgramService.get(pid)).program?.usedEvaluations).toBe(1);
    mismatch = true;
    const bad = await lifecycle.validate(pid, version.id, plan.id, randomUUID());
    expect((await lifecycle.wait(bad.id)).status).toBe("failed");
    mismatch = false;
    delay = true;
    const cancelled = await lifecycle.validate(pid, version.id, plan.id, randomUUID());
    await researchProgramService.cancel(cancelled.id);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
    release();
    expect((await lifecycle.wait(cancelled.id)).status).toBe("cancelled");
    await expect(lifecycle.validate(pid, version.id, plan.id, randomUUID())).rejects.toThrow(
      "budget_exhausted"
    );
    expect((await researchProgramService.get(pid)).program?.usedEvaluations).toBe(3);
  });
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
