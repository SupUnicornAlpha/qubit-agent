import type { IChartApi } from "lightweight-charts";

/**
 * Keep an initial K-line view legible across the terminal, mini cards and
 * embedded market components. `fitContent()` is intentionally avoided: live
 * backfill can arrive before historical bars and leave a chart permanently
 * zoomed to one or two provisional candles.
 */
export const DEFAULT_KLINE_VISIBLE_BARS = 96;

export function defaultKlineLogicalRange(
  barCount: number,
  targetBars = DEFAULT_KLINE_VISIBLE_BARS,
): { from: number; to: number } | null {
  if (!Number.isFinite(barCount) || barCount <= 0) return null;
  const visible = Math.min(Math.max(1, Math.floor(barCount)), targetBars);
  const rightPadding = Math.max(2, Math.min(8, Math.ceil(visible * 0.06)));
  return { from: Math.max(0, barCount - visible), to: barCount - 1 + rightPadding };
}

export function applyDefaultKlineViewport(
  chart: IChartApi | null | undefined,
  barCount: number,
  targetBars = DEFAULT_KLINE_VISIBLE_BARS,
): { from: number; to: number } | null {
  const range = defaultKlineLogicalRange(barCount, targetBars);
  if (chart && range) chart.timeScale().setVisibleLogicalRange(range);
  return range;
}
