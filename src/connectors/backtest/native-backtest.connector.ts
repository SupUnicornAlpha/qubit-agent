import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { backtestJob } from "../../db/sqlite/schema";
import type { ConnectorMeta } from "../../types/connector";
import { runSmaCrossoverBacktestJob } from "../../runtime/market/backtest-job-runner";
import {
  BacktestConnector,
  type BacktestResult,
  type BacktestRunStatus,
  type RunBacktestParams,
} from "./backtest.connector";

export interface NativeBacktestParams {
  symbol: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
  startDate?: string;
  endDate?: string;
  fastPeriod?: number;
  slowPeriod?: number;
  initialCapital?: number;
  commission?: number;
}

/**
 * Built-in SMA crossover backtest connector (wraps `backtest-job-runner`).
 */
export class QubitNativeBacktestConnector extends BacktestConnector {
  readonly meta: ConnectorMeta = {
    name: "qubit-backtest",
    version: "0.1.0",
    connectorType: "backtest",
    capabilities: ["run_backtest", "get_backtest_status"],
    assetClasses: ["stock"],
    latencyProfile: "batch",
    description: "Built-in SMA crossover backtest with SQLite job tracking.",
  };

  protected async onInit(): Promise<void> {}

  protected async onShutdown(): Promise<void> {}

  protected async onHealthcheck() {
    return { status: "healthy" as const, message: "qubit-backtest: SMA crossover engine ready" };
  }

  async runBacktest(params: RunBacktestParams): Promise<BacktestResult> {
    const raw = params.strategyParams as NativeBacktestParams;
    const jobId = randomUUID();
    const db = await getDb();
    const body: Record<string, unknown> = {
      symbol: raw.symbol ?? params.benchmarkSymbol ?? "",
      exchange: raw.exchange ?? "",
      timeframe: raw.timeframe ?? "1d",
      limit: raw.limit ?? 250,
      startDate: raw.startDate ?? params.startDate,
      endDate: raw.endDate ?? params.endDate,
      fastPeriod: raw.fastPeriod ?? 5,
      slowPeriod: raw.slowPeriod ?? 20,
      initialCapital: params.initialCapital,
      commission: params.commission,
    };
    await db.insert(backtestJob).values({
      id: jobId,
      status: "queued",
      kind: "sma_crossover",
      paramsJson: body,
    });
    await runSmaCrossoverBacktestJob(jobId, body);
    const rows = await db.select().from(backtestJob).where(eq(backtestJob.id, jobId)).limit(1);
    const row = rows[0];
    if (!row || row.status === "failed") {
      return {
        runId: jobId,
        status: "failed",
        performance: emptyPerformance(),
        outputUri: "",
        completedAt: new Date().toISOString(),
      };
    }
    const resultJson = row.resultJson as { backtest?: { metrics?: Record<string, number> } } | null;
    const m = resultJson?.backtest?.metrics ?? {};
    return {
      runId: jobId,
      status: "completed",
      performance: {
        totalReturn: (m.totalReturnPct ?? 0) / 100,
        annualReturn: 0,
        maxDrawdown: Math.abs(m.maxDrawdownPct ?? 0) / 100,
        sharpeRatio: m.sharpeApprox ?? 0,
        calmarRatio: 0,
        sortinoRatio: 0,
        turnover: 0,
        winRate: 0,
        tradeCount: m.tradeCount ?? 0,
        alpha: 0,
        beta: 0,
      },
      outputUri: `backtest://${jobId}`,
      completedAt: new Date().toISOString(),
    };
  }

  async getStatus(runId: string): Promise<BacktestRunStatus> {
    const db = await getDb();
    const rows = await db.select().from(backtestJob).where(eq(backtestJob.id, runId)).limit(1);
    const row = rows[0];
    if (!row) {
      return { runId, status: "failed", progress: 0, message: "job not found" };
    }
    const progress =
      row.status === "completed" ? 1 : row.status === "running" ? 0.5 : row.status === "queued" ? 0.1 : 0;
    return {
      runId,
      status: row.status === "failed" ? "failed" : row.status === "completed" ? "completed" : "running",
      progress,
      message: row.error ?? undefined,
    };
  }

  async cancelRun(_runId: string): Promise<void> {
    /* synchronous engine — no cancel */
  }

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    if (operation === "run_backtest") {
      const p = (payload ?? {}) as NativeBacktestParams & {
        initialCapital?: number;
        commission?: number;
      };
      return this.runBacktest({
        strategyCode: "sma_crossover",
        strategyParams: p,
        datasetUri: "",
        startDate: p.startDate ?? "",
        endDate: p.endDate ?? "",
        initialCapital: Number(p.initialCapital ?? 10_000),
        commission: Number(p.commission ?? 0.001),
        slippage: 0,
      }) as unknown as TOutput;
    }
    if (operation === "get_backtest_status") {
      const runId =
        typeof (payload as { runId?: string })?.runId === "string"
          ? (payload as { runId: string }).runId
          : "";
      return this.getStatus(runId) as unknown as TOutput;
    }
    return super.onExecute<TOutput>(operation, payload);
  }
}

function emptyPerformance(): BacktestResult["performance"] {
  return {
    totalReturn: 0,
    annualReturn: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    calmarRatio: 0,
    sortinoRatio: 0,
    turnover: 0,
    winRate: 0,
    tradeCount: 0,
    alpha: 0,
    beta: 0,
  };
}
