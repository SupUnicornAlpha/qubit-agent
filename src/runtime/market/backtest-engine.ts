import type { BarData } from "../../connectors/data/data.connector";
import {
  type PerformanceMetrics,
  computePerformanceMetrics,
} from "../backtest/performance-metrics";

export interface SmaCrossoverBacktestParams {
  fastPeriod: number;
  slowPeriod: number;
  initialCapital: number;
  /** Fractional commission per trade side (e.g. 0.001 = 0.1%). */
  commission: number;
}

export interface EquityPoint {
  time: string;
  equity: number;
}

export interface SmaCrossoverResult {
  equityCurve: EquityPoint[];
  metrics: PerformanceMetrics & {
    totalReturnPct: number;
    maxDrawdownPct: number;
    sharpeApprox: number;
    tradeCount: number;
    bars: number;
  };
}

function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(Number.NaN);
    } else {
      let s = 0;
      for (let j = 0; j < period; j++) s += values[i - j] ?? 0;
      out.push(s / period);
    }
  }
  return out;
}

/**
 * Long-only SMA crossover: all-in on golden cross, flat on death cross.
 * Uses bar close prices; deterministic for a given `BarData[]`.
 */
export function runSmaCrossoverBacktest(
  bars: BarData[],
  p: SmaCrossoverBacktestParams
): SmaCrossoverResult {
  const closes = bars.map((b) => b.close);
  const fast = Math.max(1, Math.floor(p.fastPeriod));
  const slow = Math.max(fast + 1, Math.floor(p.slowPeriod));
  const smaF = sma(closes, fast);
  const smaS = sma(closes, slow);
  let cash = p.initialCapital;
  let shares = 0;
  let position: 0 | 1 = 0;
  let trades = 0;
  let totalCommission = 0;
  let tradedNotional = 0;
  const equityCurve: EquityPoint[] = [];
  const fee = Math.max(0, p.commission);

  for (let i = 0; i < bars.length; i++) {
    const f = smaF[i];
    const s = smaS[i];
    const previousFast = i > 0 ? smaF[i - 1] : undefined;
    const previousSlow = i > 0 ? smaS[i - 1] : undefined;
    const bar = bars[i];
    if (!bar) continue;
    if (
      i > 0 &&
      Number.isFinite(f) &&
      Number.isFinite(s) &&
      Number.isFinite(previousFast) &&
      Number.isFinite(previousSlow)
    ) {
      const crossUp = (previousFast ?? 0) <= (previousSlow ?? 0) && (f ?? 0) > (s ?? 0);
      const crossDown = (previousFast ?? 0) >= (previousSlow ?? 0) && (f ?? 0) < (s ?? 0);
      const price = bar.close;
      if (crossUp && position === 0 && cash > 0 && price > 0) {
        const feePaid = cash * fee;
        const lot = (cash - feePaid) / price;
        shares = lot;
        cash = 0;
        position = 1;
        trades++;
        totalCommission += feePaid;
        tradedNotional += lot * price;
      } else if (crossDown && position === 1 && shares > 0 && price > 0) {
        const gross = shares * price;
        cash = gross * (1 - fee);
        shares = 0;
        position = 0;
        trades++;
        totalCommission += gross * fee;
        tradedNotional += gross;
      }
    }
    const eq = cash + shares * bar.close;
    equityCurve.push({ time: bar.timestamp, equity: eq });
  }

  const firstEq = equityCurve[0]?.equity ?? p.initialCapital;
  const lastEq = equityCurve[equityCurve.length - 1]?.equity ?? firstEq;
  const totalReturnPct = firstEq > 0 ? ((lastEq - firstEq) / firstEq) * 100 : 0;

  const performance = computePerformanceMetrics({ equityCurve, initialCapital: p.initialCapital });
  const years = Math.max(1 / 252, equityCurve.length / 252);
  const turnover = firstEq > 0 ? tradedNotional / firstEq / years : 0;

  return {
    equityCurve,
    metrics: {
      ...performance,
      totalReturnPct,
      maxDrawdownPct: performance.maxDrawdown * 100,
      sharpeApprox: performance.sharpe,
      tradeCount: trades,
      bars: bars.length,
      turnover,
      totalCommission,
    },
  };
}
