/**
 * Self-Evolving Agent P4a — 时间口径工具
 *
 * 为什么需要：
 *   - `analyst_accuracy_log.signal_date / evaluated_at` 是 integer "epoch day"
 *     （仓库其他地方都是 ISO text，0004 历史遗留）。PnL writer 必须按 epoch day
 *     处理这两个字段，否则 reader `signal-fusion.ts` 拿不到。
 *   - `daily_mark_price.trading_day` / `strategy_pnl_snapshot.trading_day` 是
 *     ISO date 'YYYY-MM-DD'，按 market 本地交易日（CN=Asia/Shanghai，US=America/New_York 等）。
 *   - 不在调用方临时拼时区字符串 —— 集中此处，避免 4 套不同的时间转换。
 *
 * 设计原则：
 *   - 一切对外接口都接 `Date` 或 ISO 字符串，输出确定性的 epoch day / trading day。
 *   - 不引入新依赖；用 `Intl.DateTimeFormat` + `trading-calendar.ts` 已有的市场时区配置。
 */

import { type MarketCode, getTradingSession } from "../market/trading-calendar";

/** ms in one day */
const MS_PER_DAY = 86_400_000;

/**
 * 把 Date 转成 "epoch day"（自 1970-01-01 UTC 起的整数日数）。
 *
 * 用于 `analyst_accuracy_log.signal_date / evaluated_at`（integer）。
 * 注意：epoch day 不带时区，是 UTC 日历日；analyst_signal 跨日要看 createdAt 落在哪个 UTC 日。
 */
export function dateToEpochDay(d: Date): number {
  return Math.floor(d.getTime() / MS_PER_DAY);
}

/** 反向：epoch day → Date（UTC 00:00:00） */
export function epochDayToDate(epoch: number): Date {
  return new Date(epoch * MS_PER_DAY);
}

/** ISO 'YYYY-MM-DD' 在 UTC 解释下转 epoch day */
export function isoDateToEpochDay(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`time-util: invalid ISO date "${iso}"`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * 把 Date 按 market 本地交易日时区转成 ISO 'YYYY-MM-DD'（trading day）。
 *
 * 例：UTC 2026-06-02 22:30 在 CN(Asia/Shanghai) 是 2026-06-03，
 * 在 US(America/New_York) 是 2026-06-02。这就是为什么 daily_mark_price /
 * strategy_pnl_snapshot 要带 market 字段：同一时刻不同 market 的 trading_day 不同。
 */
export function dateToTradingDay(d: Date, market: string): string {
  const session = getTradingSession(market);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: session.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA 直接产出 'YYYY-MM-DD' 格式，不用再拼
  return fmt.format(d);
}

/**
 * 判断给定 Date 在 market 本地是否为交易日（仅看周末，不查节假日）。
 *
 * 注意：当前仓库没有节假日表（中证日历 / NYSE holidays），这里仅做"周末过滤"。
 * 真实跑批遇到 A 股节假日的 mark 缺失时，由 `mark-price-fetcher.ts` 的"上一交易日回退"
 * 策略兜底（连续 N 个 trading day 取最近一个 daily_mark_price 行）。
 */
export function isWeekendInMarket(d: Date, market: string): boolean {
  const session = getTradingSession(market);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: session.timezone,
    weekday: "short",
  });
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const part = fmt.formatToParts(d).find((p) => p.type === "weekday");
  const wd = weekdayMap[part?.value ?? "Mon"] ?? 1;
  return !session.tradingDays.includes(wd);
}

/**
 * 列出 [from, to]（含两端，UTC 解释）之间所有 market 的交易日 trading_day（'YYYY-MM-DD'）。
 *
 * 用于 mark-price-fetcher 决定要拉哪些天、PnlAttributor 决定要补哪些 snapshot 缺口。
 * 默认排除周末；不查节假日（同 isWeekendInMarket 注释）。
 */
export function listTradingDays(from: Date, to: Date, market: string): string[] {
  if (from.getTime() > to.getTime()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  let cursor = new Date(Math.floor(from.getTime() / MS_PER_DAY) * MS_PER_DAY);
  const endMs = to.getTime();
  let safety = 0;
  while (cursor.getTime() <= endMs && safety < 2000) {
    safety += 1;
    if (!isWeekendInMarket(cursor, market)) {
      const td = dateToTradingDay(cursor, market);
      if (!seen.has(td)) {
        seen.add(td);
        out.push(td);
      }
    }
    cursor = new Date(cursor.getTime() + MS_PER_DAY);
  }
  return out;
}

/**
 * 取"上一个 market 交易日"（不查节假日，仅看周末）。
 *
 * PnlAttributor 在节假日 mark 缺失时回退用：
 *   currentMark = lookupDailyMarkPriceOrPreviousTradingDay(symbol, day, market)
 */
export function previousTradingDay(d: Date, market: string): Date {
  let cursor = new Date(d.getTime() - MS_PER_DAY);
  let safety = 0;
  while (isWeekendInMarket(cursor, market) && safety < 14) {
    cursor = new Date(cursor.getTime() - MS_PER_DAY);
    safety += 1;
  }
  return cursor;
}

/** 显式的市场列表（与 trading-calendar.ts 的 MarketCode 一致） */
export const SUPPORTED_MARKETS: ReadonlyArray<MarketCode> = ["CN", "US", "HK", "CRYPTO"];
