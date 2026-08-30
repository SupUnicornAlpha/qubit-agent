import type { BacktestDataset } from "../provider/types";

export type IntradaySessionCheck = {
  symbol: string;
  timestamp: string;
  code: "intraday_session_windows_missing" | "intraday_bar_outside_frozen_session";
};

export function timeframeDurationMinutes(timeframe: string): number | null {
  const match = /^\s*(\d+)\s*(m|h)\s*$/i.exec(timeframe);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return match[2]!.toLowerCase() === "h" ? amount * 60 : amount;
}

export function isIntradayTimeframe(timeframe: string): boolean {
  return timeframeDurationMinutes(timeframe) !== null;
}

/**
 * Every intraday bar must fall into an explicitly frozen venue session. The
 * validation deliberately does not fill lunch breaks, early closes, holidays,
 * or missing windows from a hard-coded exchange calendar.
 */
export function assessIntradaySessionCoverage(dataset: BacktestDataset): IntradaySessionCheck[] {
  const checks: IntradaySessionCheck[] = [];
  for (const [symbol, bars] of Object.entries(dataset.barsBySymbol)) {
    const byDate = dataset.tradingCalendar?.sessionWindowsBySymbol?.[symbol];
    for (const bar of bars) {
      const timestamp = bar.timestamp;
      const date = timestamp.slice(0, 10);
      const windows = byDate?.[date];
      if (!windows?.length) {
        checks.push({ symbol, timestamp, code: "intraday_session_windows_missing" });
        continue;
      }
      const at = Date.parse(timestamp);
      if (
        !Number.isFinite(at) ||
        !windows.some((window) => {
          const open = Date.parse(window.openAt);
          const close = Date.parse(window.closeAt);
          return Number.isFinite(open) && Number.isFinite(close) && open <= at && at < close;
        })
      ) {
        checks.push({ symbol, timestamp, code: "intraday_bar_outside_frozen_session" });
      }
    }
  }
  return checks;
}

/**
 * Uses the frozen observed session windows, not a universal 6.5-hour market
 * assumption. It is intentionally research-only evidence until each exchange
 * supplies an official calendar history, but prevents daily annualization of
 * intraday returns.
 */
export function inferIntradayPeriodsPerYear(dataset: BacktestDataset): number | null {
  const minutesPerBar = timeframeDurationMinutes(dataset.timeframe);
  if (!minutesPerBar) return null;
  const windowsBySymbol = dataset.tradingCalendar?.sessionWindowsBySymbol ?? {};
  const minutesPerSession: number[] = [];
  for (const byDate of Object.values(windowsBySymbol)) {
    for (const windows of Object.values(byDate)) {
      const total = windows.reduce((sum, window) => {
        const duration = (Date.parse(window.closeAt) - Date.parse(window.openAt)) / 60_000;
        return sum + (Number.isFinite(duration) && duration > 0 ? duration : 0);
      }, 0);
      if (total > 0) minutesPerSession.push(total);
    }
  }
  if (minutesPerSession.length === 0) return null;
  const averageMinutes =
    minutesPerSession.reduce((sum, value) => sum + value, 0) / minutesPerSession.length;
  return Math.max(1, Math.round((averageMinutes / minutesPerBar) * 252));
}
