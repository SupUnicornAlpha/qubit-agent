import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { backtestJob } from "../../db/sqlite/schema";
import { runSmaCrossoverBacktest } from "./backtest-engine";
import { computeDateRangeForLimit, queryBarsRange, timeframeToPeriod } from "./klines-query";
import { runPythonStrategyBacktest } from "./python-strategy-backtest-runner";

const isoNow = () => new Date().toISOString();

/** POST /market/backtests JSON body (subset). */
export interface SmaBacktestBody {
  symbol?: string;
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

/** Python 策略回测 body：在 SmaBacktestBody 基础上携带 strategyCode（执行用户 on_init/on_bar）。 */
export interface PythonStrategyBacktestBody {
  symbol?: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
  startDate?: string;
  endDate?: string;
  strategyCode?: string;
  initialCapital?: number;
  commission?: number;
}

function resolveRange(params: SmaBacktestBody): {
  period: ReturnType<typeof timeframeToPeriod>;
  startDate: string;
  endDate: string;
} {
  const timeframe = String(params.timeframe ?? "1d");
  const startDate = params.startDate;
  const endDate = params.endDate;
  if (typeof startDate === "string" && typeof endDate === "string" && startDate && endDate) {
    return {
      period: timeframeToPeriod(timeframe),
      startDate,
      endDate,
    };
  }
  const limit = Math.max(20, Math.min(Number(params.limit ?? 250), 2000));
  const r = computeDateRangeForLimit(timeframe, limit);
  return { period: r.period, startDate: r.startDate, endDate: r.endDate };
}

/** Inserts job row, runs SMA crossover synchronously, updates row. */
export async function runSmaCrossoverBacktestJob(
  jobId: string,
  params: Record<string, unknown>
): Promise<void> {
  const p = params as SmaBacktestBody;
  const db = await getDb();
  await db
    .update(backtestJob)
    .set({ status: "running", updatedAt: isoNow() })
    .where(eq(backtestJob.id, jobId));

  try {
    const symbol = String(p.symbol ?? "").trim();
    if (!symbol) throw new Error("symbol is required");
    const exchange = String(p.exchange ?? "");
    const { period, startDate, endDate } = resolveRange(p);
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const result = runSmaCrossoverBacktest(bars, {
      fastPeriod: Number(p.fastPeriod ?? 5),
      slowPeriod: Number(p.slowPeriod ?? 20),
      initialCapital: Number(p.initialCapital ?? 10_000),
      commission: Number(p.commission ?? 0.001),
    });
    await db
      .update(backtestJob)
      .set({
        status: "completed",
        resultJson: { backtest: result, barCount: bars.length } as never,
        updatedAt: isoNow(),
      })
      .where(eq(backtestJob.id, jobId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(backtestJob)
      .set({
        status: "failed",
        error: msg,
        updatedAt: isoNow(),
      })
      .where(eq(backtestJob.id, jobId));
    throw e;
  }
}

/**
 * 用户 Python 策略回测：拉真实 bars → spawn python_strategy_backtest_runner.py → 落库。
 * 与 `runSmaCrossoverBacktestJob` 共用 backtest_job 表，仅 kind/paramsJson/resultJson 不同。
 */
export async function runPythonStrategyBacktestJob(
  jobId: string,
  params: Record<string, unknown>
): Promise<void> {
  const p = params as PythonStrategyBacktestBody;
  const db = await getDb();
  await db
    .update(backtestJob)
    .set({ status: "running", updatedAt: isoNow() })
    .where(eq(backtestJob.id, jobId));

  try {
    const symbol = String(p.symbol ?? "").trim();
    if (!symbol) throw new Error("symbol is required");
    const code = String(p.strategyCode ?? "").trim();
    if (!code) throw new Error("strategyCode is required");
    const exchange = String(p.exchange ?? "");
    const { period, startDate, endDate } = resolveRange(p);
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const result = await runPythonStrategyBacktest({
      strategyCode: code,
      bars,
      initialCapital: Number(p.initialCapital ?? 10_000),
      commission: Number(p.commission ?? 0.001),
    });
    await db
      .update(backtestJob)
      .set({
        status: "completed",
        resultJson: {
          backtest: { equityCurve: result.equityCurve, metrics: result.metrics },
          trades: result.trades,
          barCount: bars.length,
          stderrText: result.stderrText,
        } as never,
        updatedAt: isoNow(),
      })
      .where(eq(backtestJob.id, jobId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(backtestJob)
      .set({
        status: "failed",
        error: msg,
        updatedAt: isoNow(),
      })
      .where(eq(backtestJob.id, jobId));
    throw e;
  }
}
