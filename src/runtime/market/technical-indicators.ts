import type { BarData } from "../../connectors/data/data.connector";

function numSeries(bars: BarData[]): number[] {
  return bars.map((b) => b.close);
}

export function computeSma(values: number[], period: number): number[] {
  const p = Math.max(1, Math.floor(period));
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < p - 1) {
      out.push(Number.NaN);
    } else {
      let s = 0;
      for (let j = 0; j < p; j++) s += values[i - j];
      out.push(s / p);
    }
  }
  return out;
}

export function computeEma(values: number[], period: number): number[] {
  const p = Math.max(1, Math.floor(period));
  const k = 2 / (p + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      out.push(prev);
    } else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

export function computeRsi(values: number[], period = 14): number[] {
  const p = Math.max(2, Math.floor(period));
  const out: number[] = new Array(values.length).fill(Number.NaN);
  if (values.length <= p) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / p;
  let avgLoss = loss / p;
  out[p] = avgLoss < 1e-12 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = p + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (p - 1) + g) / p;
    avgLoss = (avgLoss * (p - 1) + l) / p;
    out[i] = avgLoss < 1e-12 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdSeries {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function computeMacd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): MacdSeries {
  const emaFast = computeEma(values, fast);
  const emaSlow = computeEma(values, slow);
  const macd = values.map((_, i) => emaFast[i] - emaSlow[i]);
  const signal = computeEma(macd.map((v) => (Number.isFinite(v) ? v : 0)), signalPeriod);
  const histogram = macd.map((m, i) => m - signal[i]);
  return { macd, signal, histogram };
}

export interface BollingerSeries {
  middle: number[];
  upper: number[];
  lower: number[];
}

export function computeBollinger(values: number[], period = 20, stdMult = 2): BollingerSeries {
  const middle = computeSma(values, period);
  const upper: number[] = [];
  const lower: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      upper.push(Number.NaN);
      lower.push(Number.NaN);
      continue;
    }
    const window = values.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = window.reduce((a, x) => a + (x - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper.push(mean + stdMult * std);
    lower.push(mean - stdMult * std);
  }
  return { middle, upper, lower };
}

export interface IndicatorSnapshot {
  symbol: string;
  barCount: number;
  lastClose: number;
  return20d: number;
  sma20: number | null;
  sma60: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  bollinger: { upper: number | null; middle: number | null; lower: number | null };
}

export function snapshotIndicators(bars: BarData[], symbol: string): IndicatorSnapshot {
  const closes = numSeries(bars);
  const n = closes.length;
  const last = n > 0 ? closes[n - 1] : 0;
  const ret20 =
    n >= 21 && closes[n - 21] > 0 ? (last - closes[n - 21]) / closes[n - 21] : 0;
  const sma20Arr = computeSma(closes, 20);
  const sma60Arr = computeSma(closes, 60);
  const rsi = computeRsi(closes, 14);
  const macd = computeMacd(closes);
  const bb = computeBollinger(closes, 20, 2);
  const lastIdx = n - 1;
  return {
    symbol,
    barCount: n,
    lastClose: last,
    return20d: ret20,
    sma20: lastIdx >= 0 && Number.isFinite(sma20Arr[lastIdx]) ? sma20Arr[lastIdx] : null,
    sma60: lastIdx >= 0 && Number.isFinite(sma60Arr[lastIdx]) ? sma60Arr[lastIdx] : null,
    rsi14: lastIdx >= 0 && Number.isFinite(rsi[lastIdx]) ? rsi[lastIdx] : null,
    macd: lastIdx >= 0 && Number.isFinite(macd.macd[lastIdx]) ? macd.macd[lastIdx] : null,
    macdSignal:
      lastIdx >= 0 && Number.isFinite(macd.signal[lastIdx]) ? macd.signal[lastIdx] : null,
    bollinger: {
      upper: lastIdx >= 0 && Number.isFinite(bb.upper[lastIdx]) ? bb.upper[lastIdx] : null,
      middle: lastIdx >= 0 && Number.isFinite(bb.middle[lastIdx]) ? bb.middle[lastIdx] : null,
      lower: lastIdx >= 0 && Number.isFinite(bb.lower[lastIdx]) ? bb.lower[lastIdx] : null,
    },
  };
}
