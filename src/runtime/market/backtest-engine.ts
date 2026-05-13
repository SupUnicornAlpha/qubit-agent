import type { BarData } from "../../connectors/data/data.connector";

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
  metrics: {
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
      for (let j = 0; j < period; j++) s += values[i - j];
      out.push(s / period);
    }
  }
  return out;
}

/**
 * Long-only SMA crossover: all-in on golden cross, flat on death cross.
 * Uses bar close prices; deterministic for a given `BarData[]`.
 */
export function runSmaCrossoverBacktest(bars: BarData[], p: SmaCrossoverBacktestParams): SmaCrossoverResult {
  const closes = bars.map((b) => b.close);
  const fast = Math.max(1, Math.floor(p.fastPeriod));
  const slow = Math.max(fast + 1, Math.floor(p.slowPeriod));
  const smaF = sma(closes, fast);
  const smaS = sma(closes, slow);
  let cash = p.initialCapital;
  let shares = 0;
  let position: 0 | 1 = 0;
  let trades = 0;
  const equityCurve: EquityPoint[] = [];
  const fee = Math.max(0, p.commission);

  for (let i = 0; i < bars.length; i++) {
    const f = smaF[i];
    const s = smaS[i];
    if (
      i > 0 &&
      Number.isFinite(f) &&
      Number.isFinite(s) &&
      Number.isFinite(smaF[i - 1]) &&
      Number.isFinite(smaS[i - 1])
    ) {
      const crossUp = smaF[i - 1] <= smaS[i - 1] && f > s;
      const crossDown = smaF[i - 1] >= smaS[i - 1] && f < s;
      const price = bars[i].close;
      if (crossUp && position === 0 && cash > 0 && price > 0) {
        const lot = (cash * (1 - fee)) / price;
        shares = lot;
        cash = 0;
        position = 1;
        trades++;
      } else if (crossDown && position === 1 && shares > 0 && price > 0) {
        const gross = shares * price;
        cash = gross * (1 - fee);
        shares = 0;
        position = 0;
        trades++;
      }
    }
    const eq = cash + shares * bars[i].close;
    equityCurve.push({ time: bars[i].timestamp, equity: eq });
  }

  const firstEq = equityCurve[0]?.equity ?? p.initialCapital;
  const lastEq = equityCurve[equityCurve.length - 1]?.equity ?? firstEq;
  const totalReturnPct = firstEq > 0 ? ((lastEq - firstEq) / firstEq) * 100 : 0;

  let peak = firstEq;
  let maxDd = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak > 0 ? (peak - pt.equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const a = equityCurve[i - 1].equity;
    const b = equityCurve[i].equity;
    if (a > 1e-8) rets.push((b - a) / a);
  }
  let sharpeApprox = 0;
  if (rets.length > 2) {
    const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
    const variance = rets.reduce((x, r) => x + (r - mean) ** 2, 0) / rets.length;
    const std = Math.sqrt(variance) || 1e-9;
    sharpeApprox = (mean / std) * Math.sqrt(Math.min(252, rets.length));
  }

  return {
    equityCurve,
    metrics: {
      totalReturnPct,
      maxDrawdownPct: maxDd * 100,
      sharpeApprox,
      tradeCount: trades,
      bars: bars.length,
    },
  };
}
