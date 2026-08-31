import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import * as schema from "../../../db/sqlite/schema";
import { defaultDataDir } from "../../app-paths";
import { finalHoldoutEvaluationService } from "../../effect-validation/final-holdout-evaluation-service";
import {
  createWalkForwardWindows,
  walkForwardEvaluationService,
} from "../../effect-validation/walk-forward-evaluation-service";
import { factorService } from "../../factor/factor-service";
import { buildMarketSnapshotRecord } from "../../market/contracts/market-snapshot-service";
import { _resetBootstrapForTests, bootstrapProviders } from "../../provider/bootstrap";
import { providerRegistry } from "../../provider/registry";
import type {
  BacktestProvider,
  BacktestRequest,
  BacktestResult,
  ProviderMeta,
} from "../../provider/types";
import { strategyComposer } from "../../strategy/strategy-composer";
import { backtestJobService } from "../backtest-job-service";

class StubBacktestProvider implements BacktestProvider {
  readonly meta: ProviderMeta = {
    kind: "backtest",
    key: "stub_bt",
    displayName: "Stub Backtest (test only)",
    version: "0.0.1",
    capability: { features: ["test_only"] },
    isBuiltin: false,
    isFallback: false,
  };
  lastRequest: BacktestRequest | null = null;
  async healthCheck() {
    return { ok: true };
  }
  async run(req: BacktestRequest): Promise<BacktestResult> {
    this.lastRequest = req;
    // 简单回测；topN=2 在训练窗上更优，供 train-only selection 回归测试。
    const sharpe = req.topN === 2 ? 0.9 : 0.5;
    return {
      equityCurve: [
        { date: req.startDate, equity: req.capital },
        { date: req.endDate, equity: req.capital * 1.05 },
      ],
      trades: [],
      metrics: {
        totalReturn: 0.05,
        annualReturn: 0.05,
        annualVol: 0.1,
        sharpe,
        maxDrawdown: 0.02,
        winRate: 0.55,
        tradeCount: 0,
        turnover: 0,
      },
      meta: { latencyMs: 1, sampleSize: 2, barCount: 0, skippedDays: 0 },
    };
  }
}

let projectId = "";
let strategyVersionId = "";
let datasetSnapshotId = "";
let stubBacktestProvider: StubBacktestProvider;

async function seedDatasetSnapshot(
  symbols: string[],
  options: { includeHoldoutBars?: boolean; timeframe?: string } = {}
): Promise<string> {
  const includeHoldoutBars = options.includeHoldoutBars ?? true;
  const timeframe = options.timeframe ?? "1d";
  const barsByInstrument = Object.fromEntries(
    symbols.map((symbol, offset) => [
      `US:${symbol}`,
      [
        {
          timestamp: "2026-01-02T00:00:00.000Z",
          open: 100 + offset,
          high: 102 + offset,
          low: 99 + offset,
          close: 101 + offset,
          volume: 1000,
          turnover: 101000,
        },
        {
          timestamp: "2026-01-30T00:00:00.000Z",
          open: 101 + offset,
          high: 103 + offset,
          low: 100 + offset,
          close: 102 + offset,
          volume: 1100,
          turnover: 112200,
        },
        ...(includeHoldoutBars
          ? [
              {
                timestamp: "2026-02-26T00:00:00.000Z",
                open: 102 + offset,
                high: 104 + offset,
                low: 101 + offset,
                close: 103 + offset,
                volume: 1200,
                turnover: 123600,
              },
            ]
          : []),
      ],
    ])
  );
  const record = buildMarketSnapshotRecord({
    asOf: includeHoldoutBars ? "2026-02-28T00:00:00.000Z" : "2026-01-31T00:00:00.000Z",
    purpose: "backtest",
    instruments: symbols.map((symbol) => ({ symbol, venue: "US", assetClass: "equity" as const })),
    window: { start: "2026-01-01", end: includeHoldoutBars ? "2026-02-28" : "2026-01-31" },
    sources: [{ provider: "test_dataset", feed: "fixture", upstreamFamily: "fixture" }],
    barsByInstrument,
    timeframe,
    limit: includeHoldoutBars ? 3 : 2,
  });
  const root = join(defaultDataDir(), "market-snapshots");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${record.snapshot.snapshotId}.json`), JSON.stringify(record), "utf8");
  return record.snapshot.snapshotId;
}

beforeAll(async () => {
  await runMigrations();
  _resetBootstrapForTests();
  await bootstrapProviders();
  // 把 stub 注入 registry，并把它在 db 里 priority 调到最高
  stubBacktestProvider = new StubBacktestProvider();
  providerRegistry.register(stubBacktestProvider);
  await providerRegistry.syncToDb();

  const db = await getDb();
  const wid = randomUUID();
  projectId = randomUUID();
  await db.insert(schema.workspace).values({ id: wid, name: "bt-ws", owner: "test" });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId: wid,
    name: "bt-proj",
    marketScope: "CN-A",
    status: "active",
  });
  const strategyId = randomUUID();
  await db.insert(schema.strategy).values({
    id: strategyId,
    projectId,
    name: "test-strategy",
    style: "low_freq",
  });
  strategyVersionId = randomUUID();
  await db.insert(schema.strategyVersion).values({
    id: strategyVersionId,
    strategyId,
    versionTag: "v1",
    logicHash: "abc",
    paramSchemaJson: {},
  });
  datasetSnapshotId = await seedDatasetSnapshot(["AAA", "BBB"]);
});

describe("BacktestJobService", () => {
  test("preserves an explicitly requested intraday timeframe through snapshot binding", async () => {
    const intradaySnapshotId = await seedDatasetSnapshot(["INTRA"], { timeframe: "5m" });
    const job = await backtestJobService.submitAndRun({
      strategyVersionId,
      signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
      symbols: ["INTRA"],
      datasetSnapshotId: intradaySnapshotId,
      timeframe: "5m",
      startDate: "2026-01-01",
      endDate: "2026-02-28",
      providerKey: "stub_bt",
    });

    expect(job.status).toBe("completed");
    expect(job.config.dataset.timeframe).toBe("5m");
    expect(stubBacktestProvider.lastRequest?.dataset.timeframe).toBe("5m");
  });

  test("submit + run：状态机 pending → running → completed，结果落 performanceJson", async () => {
    const job = await backtestJobService.submit({
      strategyVersionId,
      signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
      symbols: ["AAA", "BBB"],
      datasetSnapshotId,
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      capital: 1_000_000,
      providerKey: "stub_bt",
    });
    expect(job.status).toBe("pending");
    expect(job.engineKey).toBe("stub_bt");
    expect(job.config.experiment).toEqual({ parameterSelection: "unknown" });
    expect(job.config.costs).toMatchObject({
      commissionBps: 5,
      slippageBps: 5,
      costModelVersion: "builtin-default-v1",
      costModelSource: "unverified_default_assumption",
    });

    const ran = await backtestJobService.run(job.id);
    expect(ran.status).toBe("completed");
    expect(ran.result?.metrics.totalReturn).toBe(0.05);
    expect(ran.providerId).toBe("stub_bt");
    expect(ran.endedAt).not.toBeNull();
    expect(ran.evaluation).not.toBeNull();
    expect(ran.evaluation?.checks).toHaveLength(12);
    expect(ran.evaluation?.checks.find((check) => check.key === "research_integrity")?.pass).toBe(
      false
    );
    expect(
      ran.evaluation?.checks.find((check) => check.key === "statistical_confidence")?.pass
    ).toBe(false);
    expect(ran.evaluation?.checks.find((check) => check.key === "net_sharpe")?.pass).toBe(true);
    expect(ran.evaluation?.checks.find((check) => check.key === "cvar95")?.pass).toBe(false);
    expect(ran.evaluation?.pass).toBe(false);

    const db = await getDb();
    const evalRows = await db
      .select()
      .from(schema.strategyEvalRun)
      .where(eq(schema.strategyEvalRun.backtestRunId, job.id));
    expect(evalRows).toHaveLength(1);

    const walkForward = await walkForwardEvaluationService.run(job.id, {
      folds: 3,
      purgeDays: 2,
    });
    expect(walkForward.folds).toHaveLength(3);
    expect(walkForward.aggregate.compoundedOosReturn).toBeCloseTo(0.157625, 6);
    expect(walkForward.performancePass).toBe(true);
    expect(walkForward.integrityReport.status).toBe("research_only");
    expect(
      walkForward.integrityReport.checks.find((check) => check.key === "embargo_isolation")?.state
    ).toBe("pass");
    expect(
      walkForward.integrityReport.checks.find((check) => check.key === "parameter_selection")?.state
    ).toBe("unknown");
    expect(walkForward.statisticalValidationReport.status).toBe("research_only");
    expect(walkForward.pass).toBe(false);
    const tuned = await walkForwardEvaluationService.run(job.id, {
      folds: 3,
      purgeDays: 2,
      selection: {
        objective: "sharpe",
        candidates: [
          { topN: 1, rebalance: "daily" },
          { topN: 2, rebalance: "daily" },
        ],
      },
    });
    expect(tuned.folds.every((fold) => fold.selection?.selected.topN === 2)).toBe(true);
    expect(tuned.folds.every((fold) => fold.selection?.candidateCount === 2)).toBe(true);
    expect(
      tuned.folds.every((fold) => fold.selection?.falseDiscoveryRate.hypothesisCount === 2)
    ).toBe(true);
    expect(tuned.folds.every((fold) => fold.selection?.realityCheck.candidateCount === 2)).toBe(
      true
    );
    expect(tuned.selectionIntegrityPass).toBe(false);
    expect(
      tuned.integrityReport.checks.find((check) => check.key === "parameter_selection")?.state
    ).toBe("pass");
    await walkForwardEvaluationService.run(job.id, { folds: 3, purgeDays: 2 });
    const holdout = await finalHoldoutEvaluationService.run(job.id, {
      trainEnd: "2026-01-31",
      holdoutStart: "2026-02-06",
      holdoutEnd: "2026-02-28",
      purgeDays: 2,
      embargoDays: 2,
    });
    expect(holdout.contract.fingerprint).toMatch(/^holdout_/);
    expect(
      holdout.integrityReport.checks.find((check) => check.key === "oos_isolation")?.state
    ).toBe("pass");
    expect(stubBacktestProvider.lastRequest?.dataset.snapshotId).toBe(datasetSnapshotId);
    expect(stubBacktestProvider.lastRequest?.dataset.barsBySymbol.AAA?.[0]?.timestamp).toContain(
      "2026-02"
    );
    await expect(
      finalHoldoutEvaluationService.run(job.id, {
        trainEnd: "2026-01-31",
        holdoutStart: "2026-02-06",
        holdoutEnd: "2026-02-28",
        purgeDays: 2,
        embargoDays: 2,
      })
    ).rejects.toThrow("final_holdout_already_evaluated");
    await expect(
      finalHoldoutEvaluationService.run(job.id, {
        trainEnd: "2026-01-31",
        holdoutStart: "2026-02-09",
        holdoutEnd: "2026-02-28",
        purgeDays: 2,
        embargoDays: 2,
      })
    ).rejects.toThrow("final_holdout_window_already_reserved");
    const walkForwardRows = await db
      .select()
      .from(schema.strategyEvalRun)
      .where(eq(schema.strategyEvalRun.backtestRunId, job.id));
    expect(walkForwardRows.filter((row) => row.evalKind === "walk_forward")).toHaveLength(1);
    expect(walkForwardRows.filter((row) => row.evalKind === "holdout")).toHaveLength(1);
  });

  test("walk-forward windows use expanding train period and purge gap", () => {
    const windows = createWalkForwardWindows("2026-01-01", "2026-04-30", 3, 5, 4);
    expect(windows).toHaveLength(3);
    expect(windows[0]?.trainStart).toBe("2026-01-01");
    expect(Date.parse(windows[1]?.trainEnd ?? "")).toBeGreaterThan(
      Date.parse(windows[0]?.trainEnd ?? "")
    );
    expect(Date.parse(windows[0]?.testStart ?? "")).toBeGreaterThan(
      Date.parse(windows[0]?.trainEnd ?? "")
    );
    expect(
      (Date.parse(windows[0]?.testStart ?? "") - Date.parse(windows[0]?.trainEnd ?? "")) /
        86_400_000
    ).toBe(10);
    expect(windows[0]?.purgeStart).not.toBeNull();
    expect(windows[0]?.embargoEnd).toBe(
      new Date(Date.parse(windows[0]?.testStart ?? "") - 86_400_000).toISOString().slice(0, 10)
    );
  });

  test("final holdout rejects a reserved window outside the frozen snapshot", async () => {
    const shortSnapshotId = await seedDatasetSnapshot(["AAA", "BBB"], {
      includeHoldoutBars: false,
    });
    const source = await backtestJobService.submitAndRun({
      strategyVersionId,
      signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
      symbols: ["AAA", "BBB"],
      datasetSnapshotId: shortSnapshotId,
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      providerKey: "stub_bt",
    });

    await expect(
      finalHoldoutEvaluationService.run(source.id, {
        trainEnd: "2026-01-31",
        holdoutStart: "2026-02-06",
        holdoutEnd: "2026-02-28",
      })
    ).rejects.toThrow("dataset_snapshot_window_mismatch");
  });

  test("缺 signals + 缺 compositionId → validation_failed", async () => {
    await expect(
      backtestJobService.submit({
        strategyVersionId,
        symbols: ["AAA"],
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      })
    ).rejects.toThrow(/either_signals_or_composition_id_required/);
  });

  test("缺 datasetSnapshotId → 拒绝回测，不能在运行中临时取行情", async () => {
    await expect(
      backtestJobService.submit({
        strategyVersionId,
        signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
        symbols: ["AAA"],
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      })
    ).rejects.toThrow(/dataset_snapshot_required/);
  });

  test("非法 parameterSelection 在服务边界被拒绝", async () => {
    await expect(
      backtestJobService.submit({
        strategyVersionId,
        signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
        symbols: ["AAA"],
        datasetSnapshotId,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        experiment: { parameterSelection: "optimized_somehow" } as never,
      })
    ).rejects.toThrow(/invalid_parameter_selection/);
  });

  test("非法 candidateTrials 在服务边界被拒绝", async () => {
    await expect(
      backtestJobService.submit({
        strategyVersionId,
        signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
        symbols: ["AAA"],
        datasetSnapshotId,
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        experiment: { parameterSelection: "fixed_before_run", candidateTrials: 0 },
      })
    ).rejects.toThrow(/invalid_candidate_trials/);
  });

  test("compositionId 解析：自动取 composition 第一个 factor 作为 signal", async () => {
    // 1. 注册一个因子
    const factor = await factorService.register({
      projectId,
      name: `bt_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "close / Ref(close, 5) - 1",
      lang: "qlib_expr",
    });
    // 2. 定义 composition
    const comp = await strategyComposer.define({
      strategyVersionId,
      kind: "factor_score",
      factorIds: [factor.id],
    });
    // 3. 用 compositionId 提交回测
    const job = await backtestJobService.submitAndRun({
      strategyVersionId,
      compositionId: comp.id,
      symbols: ["AAA"],
      datasetSnapshotId,
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      providerKey: "stub_bt",
    });
    expect(job.status).toBe("completed");
    expect(job.config.signals.kind).toBe("factor_score");
    if (job.config.signals.kind === "factor_score") {
      expect(job.config.signals.factorId).toBe(factor.id);
      expect(job.config.signals.expr).toBe("close / Ref(close, 5) - 1");
    }
  });

  test("多因子 composition 会保留全部因子与权重，不再静默丢弃到第一个", async () => {
    const factors = await Promise.all(
      ["close", "volume"].map((expr, index) =>
        factorService.register({
          projectId,
          name: `bt_multi_${index}_${randomUUID().slice(0, 6)}`,
          category: "momentum",
          expr,
          lang: "qlib_expr",
        })
      )
    );
    const comp = await strategyComposer.define({
      strategyVersionId,
      kind: "factor_score",
      factorIds: factors.map((factor) => factor.id),
      weightMethod: "equal",
    });
    const job = await backtestJobService.submit({
      strategyVersionId,
      compositionId: comp.id,
      symbols: ["AAA", "BBB"],
      datasetSnapshotId,
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      providerKey: "stub_bt",
    });
    expect(job.config.signals.kind).toBe("factor_composite");
    if (job.config.signals.kind === "factor_composite") {
      expect(job.config.signals.factors).toHaveLength(2);
      expect(job.config.signals.factors.map((factor) => factor.factorId).sort()).toEqual(
        factors.map((factor) => factor.id).sort()
      );
      expect(job.config.signals.factors.every((factor) => factor.weight === 0.5)).toBe(true);
    }
  });

  test("list 按 strategyVersionId 过滤", async () => {
    const rows = await backtestJobService.list({ strategyVersionId });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.strategyVersionId).toBe(strategyVersionId);
  });

  test("strategy_version 不存在 → strategy_version_not_found", async () => {
    await expect(
      backtestJobService.submit({
        strategyVersionId: "nonexistent",
        signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
        symbols: ["AAA"],
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      })
    ).rejects.toThrow(/strategy_version_not_found/);
  });
});
