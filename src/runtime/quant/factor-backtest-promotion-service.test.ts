import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import * as schema from "../../db/sqlite/schema";
import { factorService } from "../factor/factor-service";
import { _resetBootstrapForTests, bootstrapProviders } from "../provider/bootstrap";
import { providerRegistry } from "../provider/registry";
import type {
  BacktestProvider,
  BacktestRequest,
  BacktestResult,
  ProviderMeta,
} from "../provider/types";
import { factorBacktestPromotionService } from "./factor-backtest-promotion-service";

class PromotionStubBacktestProvider implements BacktestProvider {
  readonly meta: ProviderMeta = {
    kind: "backtest",
    key: "promotion_stub_bt",
    displayName: "Promotion Stub Backtest",
    version: "0.0.1",
    capability: { features: ["test_only"] },
    isBuiltin: false,
    isFallback: false,
  };

  async healthCheck() {
    return { ok: true };
  }

  async run(req: BacktestRequest): Promise<BacktestResult> {
    return {
      equityCurve: [
        { date: req.startDate, equity: req.capital },
        { date: req.endDate, equity: req.capital * 1.03 },
      ],
      trades: [],
      metrics: {
        totalReturn: 0.03,
        annualReturn: 0.03,
        annualVol: 0.08,
        sharpe: 0.375,
        maxDrawdown: 0.01,
        winRate: 0.6,
        tradeCount: 0,
        turnover: 0,
      },
      meta: { latencyMs: 1, sampleSize: 2, barCount: 2, skippedDays: 0 },
    };
  }
}

let projectId = "";
let workflowRunId = "";

beforeAll(async () => {
  await runMigrations();
  _resetBootstrapForTests();
  await bootstrapProviders();
  providerRegistry.register(new PromotionStubBacktestProvider());
  await providerRegistry.syncToDb();

  const db = await getDb();
  const workspaceId = randomUUID();
  projectId = randomUUID();
  workflowRunId = randomUUID();
  await db.insert(schema.workspace).values({ id: workspaceId, name: "promotion-ws", owner: "test" });
  await db.insert(schema.project).values({
    id: projectId,
    workspaceId,
    name: "promotion-project",
    marketScope: "US",
    status: "active",
  });
  await db.insert(schema.workflowRun).values({
    id: workflowRunId,
    projectId,
    goal: "factor to backtest promotion",
    mode: "research",
    source: "api",
    status: "completed",
  });
});

describe("FactorBacktestPromotionService", () => {
  test("promotes factors into strategy composition and runs observable backtest", async () => {
    const factor = await factorService.register({
      projectId,
      name: `promo_factor_${randomUUID().slice(0, 6)}`,
      category: "momentum",
      expr: "Mean(close, 20) - Mean(close, 60)",
      lang: "qlib_expr",
      universe: "US",
      workflowRunId,
      createdBy: "agent",
    });

    const result = await factorBacktestPromotionService.promoteAndBacktest({
      projectId,
      factorIds: [factor.id],
      symbols: ["AAPL", "MSFT"],
      universe: "US",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      providerKey: "promotion_stub_bt",
      workflowRunId,
      createdBy: "agent",
    });

    expect(result.strategyVersion.workflowRunId).toBe(workflowRunId);
    expect(result.composition.workflowRunId).toBe(workflowRunId);
    expect(result.composition.factorIds).toEqual([factor.id]);
    expect(result.backtest.workflowRunId).toBe(workflowRunId);
    expect(result.backtest.compositionId).toBe(result.composition.id);
    expect(result.backtest.status).toBe("completed");
    expect(result.backtest.result?.metrics.totalReturn).toBe(0.03);

    const db = await getDb();
    const evalRows = await db
      .select()
      .from(schema.strategyEvalRun)
      .where(eq(schema.strategyEvalRun.backtestRunId, result.backtest.id));
    expect(evalRows).toHaveLength(1);
    expect(evalRows[0]?.workflowRunId).toBe(workflowRunId);
    expect(evalRows[0]?.compositionId).toBe(result.composition.id);

    const byProject = await import("../backtest/backtest-job-service").then((m) =>
      m.backtestJobService.list({ projectId, workflowRunId })
    );
    expect(byProject.some((row) => row.id === result.backtest.id)).toBe(true);
  });
});
