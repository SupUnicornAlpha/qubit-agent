import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { getDb } from "../../../db/sqlite/client";
import * as schema from "../../../db/sqlite/schema";
import { runMigrations } from "../../../db/sqlite/migrate";
import { _resetBootstrapForTests, bootstrapProviders } from "../../provider/bootstrap";
import { providerRegistry } from "../../provider/registry";
import { factorService } from "../../factor/factor-service";
import { strategyComposer } from "../../strategy/strategy-composer";
import type {
  BacktestProvider,
  BacktestRequest,
  BacktestResult,
  ProviderMeta,
} from "../../provider/types";
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
  async healthCheck() {
    return { ok: true };
  }
  async run(req: BacktestRequest): Promise<BacktestResult> {
    // 简单回测：return 5% for any input
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
        sharpe: 0.5,
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

beforeAll(async () => {
  await runMigrations();
  _resetBootstrapForTests();
  await bootstrapProviders();
  // 把 stub 注入 registry，并把它在 db 里 priority 调到最高
  providerRegistry.register(new StubBacktestProvider());
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
});

describe("BacktestJobService", () => {
  test("submit + run：状态机 pending → running → completed，结果落 performanceJson", async () => {
    const job = await backtestJobService.submit({
      strategyVersionId,
      signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
      symbols: ["AAA", "BBB"],
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      capital: 1_000_000,
      providerKey: "stub_bt",
    });
    expect(job.status).toBe("pending");
    expect(job.engineKey).toBe("stub_bt");

    const ran = await backtestJobService.run(job.id);
    expect(ran.status).toBe("completed");
    expect(ran.result?.metrics.totalReturn).toBe(0.05);
    expect(ran.providerId).toBe("stub_bt");
    expect(ran.endedAt).not.toBeNull();
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
