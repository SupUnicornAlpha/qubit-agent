/**
 * Self-Evolving Agent P4a — DailyMarkPriceFetcher
 *
 * 为什么需要：现状 mark price 只能 connector 实时拉，PnL 跑批跟外部 health
 * 绑死。本 fetcher 在交易日结束后一次性把所有持仓 symbol 的 EOD bar 物化到
 * `daily_mark_price`，PnlAttributor 后续只读本表，与 connector 解耦。
 *
 * 行为：
 *   1) 输入一组 (market, symbol)，按 market 分组；
 *   2) 对每个 market 调用注入的 `fetchBars`（默认走 `queryBarsRange`）拉 [from, to] 区间
 *      的日线（period='1d'）；
 *   3) 提取 EOD close，按 `dateToTradingDay(bar.timestamp, market)` 落 trading_day；
 *   4) `INSERT OR REPLACE` upsert（同 market+symbol+trading_day 一行），记录 source；
 *   5) 失败的 (market, symbol) 不阻塞其他 —— 单独记入返回的 failures 列表，由 caller
 *      决定告警 / 重试。
 *
 * 不做的事：
 *   - 不查节假日（同 time-util）；
 *   - 不补回历史 N 天 fallback（由 PnlAttributor 使用 previousTradingDay 回退）；
 *   - 不触发任何 worker，纯函数式。
 */

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import type { DbClient } from "../../db/sqlite/client";
import { dailyMarkPrice } from "../../db/sqlite/schema";
import { type ExperienceBus, getExperienceBus } from "../experience/experience-bus";
import { queryBarsRange } from "../market/klines-query";
import { dateToTradingDay } from "./time-util";

export type FetchBarsRangeFn = (params: {
  symbol: string;
  exchange?: string;
  period: FetchBarsParams["period"];
  startDate: string;
  endDate: string;
}) => Promise<BarData[]>;

export interface MarkPriceTarget {
  market: string;
  symbol: string;
  /** 可选；不传由 connector 自行推断（CN/US/HK 内部根据 symbol 后缀路由） */
  exchange?: string;
}

export interface FetchMarkPriceOptions {
  /** ISO date or datetime；含端 */
  from: string;
  to: string;
  /** 注入的 bar 抓取器；默认走全局 connector。单测注入 mock。 */
  fetchBarsRange?: FetchBarsRangeFn;
  /** source 标识；默认 'auto'（由 connector 决定）。手动指定可标 'synthetic_backfill' 等。 */
  sourceTag?: string;
  /** 注入：ExperienceBus；默认走全局 bus。 */
  experienceBus?: ExperienceBus;
  /** 默认 true：跑完发 maintenance_run(kind=mark_price_fetcher) 给 metrics */
  emitMetrics?: boolean;
}

export interface FetchMarkPriceResult {
  inserted: number;
  updated: number;
  skipped: number;
  failures: Array<{ market: string; symbol: string; reason: string }>;
  /** 每个 (market, symbol) 实际写入的 trading_day 列表（按市场分组） */
  writtenByTarget: Map<string, string[]>;
}

const MAX_TARGETS_PER_BATCH = 200;

export class DailyMarkPriceFetcher {
  constructor(private readonly db: DbClient) {}

  /**
   * 批量物化一组 (market, symbol) 在 [from, to] 区间内的 EOD close。
   *
   * 返回写入统计与失败明细；不抛错（除非整个 fetch 调用失败）。
   */
  async fetchAndPersist(
    targets: MarkPriceTarget[],
    opts: FetchMarkPriceOptions
  ): Promise<FetchMarkPriceResult> {
    const result: FetchMarkPriceResult = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      failures: [],
      writtenByTarget: new Map(),
    };
    if (targets.length === 0) return result;
    if (targets.length > MAX_TARGETS_PER_BATCH) {
      throw new Error(
        `mark-price-fetcher: batch size ${targets.length} > ${MAX_TARGETS_PER_BATCH}; 分批调用`
      );
    }

    const fetcher = opts.fetchBarsRange ?? queryBarsRange;
    const source = opts.sourceTag ?? "auto";

    for (const t of targets) {
      const targetKey = `${t.market}:${t.symbol}`;
      try {
        const bars = await fetcher({
          symbol: t.symbol,
          period: "1d",
          startDate: opts.from,
          endDate: opts.to,
          ...(t.exchange === undefined ? {} : { exchange: t.exchange }),
        });
        if (bars.length === 0) {
          result.skipped += 1;
          continue;
        }
        const writtenDays: string[] = [];
        for (const bar of bars) {
          const tradingDay = dateToTradingDay(new Date(bar.timestamp), t.market);
          const wrote = await this.upsertOne({
            market: t.market,
            symbol: t.symbol,
            tradingDay,
            close: bar.close,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            volume: bar.volume,
            source,
          });
          if (wrote === "inserted") result.inserted += 1;
          else if (wrote === "updated") result.updated += 1;
          writtenDays.push(tradingDay);
        }
        result.writtenByTarget.set(targetKey, writtenDays);
      } catch (err) {
        result.failures.push({
          market: t.market,
          symbol: t.symbol,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if ((opts.emitMetrics ?? true) === true) {
      const bus = opts.experienceBus ?? getExperienceBus();
      try {
        bus.emit({
          type: "maintenance_run",
          kind: "mark_price_fetcher",
          actor: "mark_price_fetcher",
          summary: {
            targets: targets.length,
            inserted: result.inserted,
            updated: result.updated,
            skipped: result.skipped,
            failures: result.failures.length,
          },
        });
      } catch {
        /* metrics emit 失败 silent */
      }
    }

    return result;
  }

  /** 单条 upsert：同 market+symbol+trading_day 已存在则 UPDATE，否则 INSERT */
  private async upsertOne(row: {
    market: string;
    symbol: string;
    tradingDay: string;
    close: number;
    open?: number;
    high?: number;
    low?: number;
    volume?: number;
    source: string;
  }): Promise<"inserted" | "updated"> {
    const existing = await this.db
      .select({ id: dailyMarkPrice.id })
      .from(dailyMarkPrice)
      .where(
        and(
          eq(dailyMarkPrice.market, row.market),
          eq(dailyMarkPrice.symbol, row.symbol),
          eq(dailyMarkPrice.tradingDay, row.tradingDay)
        )
      )
      .get();
    if (existing) {
      await this.db
        .update(dailyMarkPrice)
        .set({
          close: row.close,
          open: row.open,
          high: row.high,
          low: row.low,
          volume: row.volume,
          source: row.source,
          fetchedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        })
        .where(eq(dailyMarkPrice.id, existing.id))
        .run();
      return "updated";
    }
    await this.db
      .insert(dailyMarkPrice)
      .values({
        id: `dmp_${randomUUID()}`,
        market: row.market,
        symbol: row.symbol,
        tradingDay: row.tradingDay,
        close: row.close,
        open: row.open,
        high: row.high,
        low: row.low,
        volume: row.volume,
        source: row.source,
      })
      .run();
    return "inserted";
  }

  /**
   * Reader 帮手：取指定 (market, symbol, day) 的 mark close；不存在返回 null。
   * PnlAttributor 在算 PnL 时调用；查不到时再用 previousTradingDay 回退。
   */
  async getClose(market: string, symbol: string, tradingDay: string): Promise<number | null> {
    const row = await this.db
      .select({ close: dailyMarkPrice.close })
      .from(dailyMarkPrice)
      .where(
        and(
          eq(dailyMarkPrice.market, market),
          eq(dailyMarkPrice.symbol, symbol),
          eq(dailyMarkPrice.tradingDay, tradingDay)
        )
      )
      .get();
    return row?.close ?? null;
  }

  /**
   * 批量 reader：一次性拿多个 symbol 在某天的 close（PnlAttributor 跑批用）。
   * 返回 Map<symbol, close>；缺失的 symbol 不在 Map 内。
   */
  async getClosesByDay(
    market: string,
    symbols: string[],
    tradingDay: string
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (symbols.length === 0) return out;
    const rows = await this.db
      .select({
        symbol: dailyMarkPrice.symbol,
        close: dailyMarkPrice.close,
      })
      .from(dailyMarkPrice)
      .where(
        and(
          eq(dailyMarkPrice.market, market),
          eq(dailyMarkPrice.tradingDay, tradingDay),
          inArray(dailyMarkPrice.symbol, symbols)
        )
      )
      .all();
    for (const r of rows) out.set(r.symbol, r.close);
    return out;
  }
}

export function createDailyMarkPriceFetcher(db: DbClient): DailyMarkPriceFetcher {
  return new DailyMarkPriceFetcher(db);
}
