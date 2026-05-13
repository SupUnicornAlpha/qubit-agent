import { runSmaCrossoverBacktest } from "./backtest-engine";
import { computeDateRangeForLimit, queryBarsRange, timeframeToPeriod } from "./klines-query";

const MAX_TRIALS = 50;

export interface StructuredTuneInput {
  base: {
    symbol: string;
    exchange?: string;
    timeframe?: string;
    limit?: number;
    startDate?: string;
    endDate?: string;
  };
  fastPeriods: number[];
  slowPeriods: number[];
  initialCapital: number;
  commission: number;
}

export interface TuneTrialRow {
  fastPeriod: number;
  slowPeriod: number;
  score: number;
  metrics: ReturnType<typeof runSmaCrossoverBacktest>["metrics"];
}

export async function runStructuredTune(input: StructuredTuneInput): Promise<{
  best: TuneTrialRow | null;
  trials: TuneTrialRow[];
  barCount: number;
}> {
  const tf = input.base.timeframe ?? "1d";
  const limit = Math.max(30, Math.min(input.base.limit ?? 200, 2000));
  let period = timeframeToPeriod(tf);
  let startDate: string;
  let endDate: string;
  if (input.base.startDate && input.base.endDate) {
    startDate = input.base.startDate;
    endDate = input.base.endDate;
    period = timeframeToPeriod(tf);
  } else {
    const r = computeDateRangeForLimit(tf, limit);
    startDate = r.startDate;
    endDate = r.endDate;
    period = r.period;
  }
  const symbol = input.base.symbol.trim();
  if (!symbol) throw new Error("base.symbol is required");
  const bars = await queryBarsRange({
    symbol,
    exchange: input.base.exchange ?? "",
    period,
    startDate,
    endDate,
  });

  const trials: TuneTrialRow[] = [];
  let best: TuneTrialRow | null = null;

  for (const fp of input.fastPeriods) {
    for (const sp of input.slowPeriods) {
      if (trials.length >= MAX_TRIALS) break;
      if (sp <= fp) continue;
      const r = runSmaCrossoverBacktest(bars, {
        fastPeriod: fp,
        slowPeriod: sp,
        initialCapital: input.initialCapital,
        commission: input.commission,
      });
      const row: TuneTrialRow = {
        fastPeriod: fp,
        slowPeriod: sp,
        score: r.metrics.totalReturnPct,
        metrics: r.metrics,
      };
      trials.push(row);
      if (!best || row.score > best.score) best = row;
    }
    if (trials.length >= MAX_TRIALS) break;
  }

  return { best, trials, barCount: bars.length };
}
