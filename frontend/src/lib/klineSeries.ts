import type {
  CandlestickData,
  HistogramData,
  LineData,
  Time,
  UTCTimestamp,
} from "lightweight-charts";
import type { KlineBar } from "../api/types";

export function toChartTime(bar: KlineBar, timeframe: string): Time {
  const normalizedTimeframe = timeframe.toLowerCase();
  if (normalizedTimeframe === "1d" || normalizedTimeframe === "1w") {
    const date = bar.timestamp.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date as Time;
  }
  return Math.floor(new Date(bar.timestamp).getTime() / 1000) as UTCTimestamp;
}

function timeKey(time: Time): string {
  return typeof time === "number" ? `n:${time}` : `s:${String(time)}`;
}

function timeValue(time: Time): number | string {
  return typeof time === "number" ? time : String(time);
}

function compareTimes(left: Time, right: Time): number {
  const leftValue = timeValue(left);
  const rightValue = timeValue(right);
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    return leftValue - rightValue;
  }
  return String(leftValue).localeCompare(String(rightValue));
}

function isValidBar(bar: KlineBar, timeframe: string): boolean {
  const time = toChartTime(bar, timeframe);
  const validTime =
    typeof time === "number" ? Number.isFinite(time) : /^\d{4}-\d{2}-\d{2}$/.test(String(time));
  return (
    validTime &&
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    Number.isFinite(bar.volume)
  );
}

export function normalizeKlineBars(
  bars: KlineBar[],
  timeframe: string,
  limit?: number
): KlineBar[] {
  const byTime = new Map<string, { time: Time; bar: KlineBar }>();
  for (const bar of bars) {
    if (!isValidBar(bar, timeframe)) continue;
    const time = toChartTime(bar, timeframe);
    byTime.set(timeKey(time), { time, bar });
  }
  const normalized = [...byTime.values()]
    .sort((left, right) => compareTimes(left.time, right.time))
    .map(({ bar }) => bar);
  return limit && limit > 0 ? normalized.slice(-limit) : normalized;
}

export function barsToCandles(bars: KlineBar[], timeframe: string): CandlestickData[] {
  return normalizeKlineBars(bars, timeframe).map((bar) => ({
    time: toChartTime(bar, timeframe),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  }));
}

export function barsToVolume(bars: KlineBar[], timeframe: string): HistogramData[] {
  return normalizeKlineBars(bars, timeframe).map((bar) => ({
    time: toChartTime(bar, timeframe),
    value: bar.volume,
    color:
      bar.close >= bar.open
        ? "rgba(38, 166, 154, 0.45)"
        : "rgba(239, 83, 80, 0.45)",
  }));
}

export function lineFromSma(
  bars: KlineBar[],
  timeframe: string,
  period: number
): LineData[] {
  const normalized = normalizeKlineBars(bars, timeframe);
  const output: LineData[] = [];
  for (let index = period - 1; index < normalized.length; index += 1) {
    let sum = 0;
    for (let offset = 0; offset < period; offset += 1) {
      sum += normalized[index - offset]!.close;
    }
    output.push({
      time: toChartTime(normalized[index]!, timeframe),
      value: sum / period,
    });
  }
  return output;
}

export function lineFromEma(
  bars: KlineBar[],
  timeframe: string,
  period: number
): LineData[] {
  const normalized = normalizeKlineBars(bars, timeframe);
  if (normalized.length < period) return [];
  let value =
    normalized.slice(0, period).reduce((sum, bar) => sum + bar.close, 0) / period;
  const multiplier = 2 / (period + 1);
  const output: LineData[] = [
    { time: toChartTime(normalized[period - 1]!, timeframe), value },
  ];
  for (let index = period; index < normalized.length; index += 1) {
    value = normalized[index]!.close * multiplier + value * (1 - multiplier);
    output.push({ time: toChartTime(normalized[index]!, timeframe), value });
  }
  return output;
}

export function lineFromValues(
  bars: KlineBar[],
  timeframe: string,
  values: Array<number | null>
): LineData[] {
  const byTime = new Map<string, LineData>();
  bars.forEach((bar, index) => {
    const value = values[index];
    if (!isValidBar(bar, timeframe) || value === null || !Number.isFinite(value)) return;
    const time = toChartTime(bar, timeframe);
    byTime.set(timeKey(time), { time, value });
  });
  return [...byTime.values()].sort((left, right) => compareTimes(left.time, right.time));
}

export function histogramFromValues(
  bars: KlineBar[],
  timeframe: string,
  values: Array<number | null>
): HistogramData[] {
  const byTime = new Map<string, HistogramData>();
  bars.forEach((bar, index) => {
    const value = values[index];
    if (!isValidBar(bar, timeframe) || value === null || !Number.isFinite(value)) return;
    const time = toChartTime(bar, timeframe);
    byTime.set(timeKey(time), {
      time,
      value,
      color:
        value >= 0
          ? "rgba(38, 166, 154, 0.72)"
          : "rgba(239, 83, 80, 0.72)",
    });
  });
  return [...byTime.values()].sort((left, right) => compareTimes(left.time, right.time));
}
