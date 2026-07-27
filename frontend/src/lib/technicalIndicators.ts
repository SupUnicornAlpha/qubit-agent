export function sma(values: number[], period: number): Array<number | null> {
  const window = Math.max(1, Math.floor(period));
  const result: Array<number | null> = new Array(values.length).fill(null);
  let total = 0;
  for (let index = 0; index < values.length; index += 1) {
    total += values[index] ?? 0;
    if (index >= window) total -= values[index - window] ?? 0;
    if (index >= window - 1) result[index] = total / window;
  }
  return result;
}

export function ema(values: number[], period: number): Array<number | null> {
  const window = Math.max(1, Math.floor(period));
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (values.length < window) return result;
  let current = values.slice(0, window).reduce((sum, value) => sum + value, 0) / window;
  result[window - 1] = current;
  const multiplier = 2 / (window + 1);
  for (let index = window; index < values.length; index += 1) {
    current = (values[index] ?? current) * multiplier + current * (1 - multiplier);
    result[index] = current;
  }
  return result;
}

export function rsi(values: number[], period = 14): Array<number | null> {
  const window = Math.max(2, Math.floor(period));
  const result: Array<number | null> = new Array(values.length).fill(null);
  if (values.length <= window) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= window; index += 1) {
    const delta = (values[index] ?? 0) - (values[index - 1] ?? 0);
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  let averageGain = gains / window;
  let averageLoss = losses / window;
  result[window] =
    averageLoss < 1e-12 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = window + 1; index < values.length; index += 1) {
    const delta = (values[index] ?? 0) - (values[index - 1] ?? 0);
    averageGain = (averageGain * (window - 1) + Math.max(delta, 0)) / window;
    averageLoss = (averageLoss * (window - 1) + Math.max(-delta, 0)) / window;
    result[index] =
      averageLoss < 1e-12 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return result;
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): {
  macd: Array<number | null>;
  signal: Array<number | null>;
  histogram: Array<number | null>;
} {
  const fastSeries = ema(values, fast);
  const slowSeries = ema(values, slow);
  const line = values.map((_, index) => {
    const fastValue = fastSeries[index];
    const slowValue = slowSeries[index];
    return fastValue === null || slowValue === null ? null : fastValue - slowValue;
  });
  const first = line.findIndex((value) => value !== null);
  const signal: Array<number | null> = new Array(values.length).fill(null);
  if (first >= 0) {
    const compact = line.slice(first).map((value) => value ?? 0);
    const compactSignal = ema(compact, signalPeriod);
    compactSignal.forEach((value, index) => {
      signal[first + index] = value;
    });
  }
  return {
    macd: line,
    signal,
    histogram: line.map((value, index) => {
      const signalValue = signal[index];
      return value === null || signalValue === null ? null : value - signalValue;
    }),
  };
}

export function bollinger(
  values: number[],
  period = 20,
  standardDeviations = 2
): {
  middle: Array<number | null>;
  upper: Array<number | null>;
  lower: Array<number | null>;
} {
  const middle = sma(values, period);
  const upper: Array<number | null> = new Array(values.length).fill(null);
  const lower: Array<number | null> = new Array(values.length).fill(null);
  for (let index = period - 1; index < values.length; index += 1) {
    const mean = middle[index];
    if (mean === null) continue;
    const window = values.slice(index - period + 1, index + 1);
    const variance =
      window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
    const deviation = Math.sqrt(variance) * standardDeviations;
    upper[index] = mean + deviation;
    lower[index] = mean - deviation;
  }
  return { middle, upper, lower };
}
