/**
 * Self-Evolving Agent P4a — AnalystAccuracyWriter
 *
 * 补回 analyst_accuracy_log 的 writer（仓库历史遗留：表存在但 0 writer，导致
 * signal-fusion.ts 的 loadDynamicWeights 读到的 row 永远空，动态权重退化为 1.0）。
 *
 * 设计：两阶段、不侵入 hot path（不改 signal-fusion / analyst-team）。
 *
 *   阶段 A: syncPlaceholders(lookbackDays)
 *     从最近 N 天的 analyst_signal 同步占位行到 analyst_accuracy_log
 *     （is_correct=NULL, evaluated_at=NULL）。幂等：同 (definitionId, ticker, signalDate)
 *     已存在则跳过。注意 signal_date 是 epoch day（integer）。
 *
 *   阶段 B: evaluatePending({ evalDelayDays, upThreshold, downThreshold, asOf, getMarketForTicker })
 *     扫所有 `is_correct IS NULL AND signal_date <= asOfEpochDay - evalDelayDays` 的占位，
 *     按 daily_mark_price 算 actual_outcome（up/down/flat），回填 is_correct（1/0）。
 *
 *     评估窗口：signal_date 到 signal_date + evalDelayDays 之间的 mark 涨跌。
 *     缺 mark 则跳过（计入 skippedNoMark），不阻塞其他行。
 *
 * 调用关系：PnlAttributor.tick() 在跑批后调用 syncPlaceholders + evaluatePending。
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { analystAccuracyLog, analystSignal, dailyMarkPrice } from "../../db/sqlite/schema";
import { dateToEpochDay, dateToTradingDay, epochDayToDate, isWeekendInMarket } from "./time-util";

export interface SyncPlaceholdersOptions {
  /** 回看的天数（从 asOf 开始向前 N 天）。默认 30。 */
  lookbackDays?: number;
  /** 参考时间，默认 now */
  asOf?: Date;
}

export interface EvaluatePendingOptions {
  /** 信号产出后 N 个日历天才评估，default 5 */
  evalDelayDays?: number;
  /** mark 上涨超过此阈值视为 up；默认 +0.02 */
  upThreshold?: number;
  /** mark 下跌超过此阈值视为 down；默认 -0.02 */
  downThreshold?: number;
  /** 参考时间，默认 now */
  asOf?: Date;
  /**
   * Ticker → market 解析；默认按 ticker 后缀简单推断（'.SH'/'.SZ'/'.SS' → CN，
   * '.HK' → HK，纯字母 → US；其他 → null 跳过）。
   * 调用方可注入更精确的 mapper（如查 instrument 表）。
   */
  getMarketForTicker?: (ticker: string) => string | null;
}

export interface SyncPlaceholdersResult {
  scannedSignals: number;
  placeholdersInserted: number;
  alreadyExists: number;
  /** agentInstanceId=null 的 signal（无法关联到 agent_definition，FK 约束） */
  skippedNoAgent: number;
}

export interface EvaluatePendingResult {
  scanned: number;
  evaluated: number;
  skippedNoMark: number;
  skippedNoFutureMark: number;
  failures: Array<{ id: string; reason: string }>;
}

export class AnalystAccuracyWriter {
  constructor(private readonly db: DbClient) {}

  /** 阶段 A：同步占位 */
  async syncPlaceholders(opts: SyncPlaceholdersOptions = {}): Promise<SyncPlaceholdersResult> {
    const lookbackDays = opts.lookbackDays ?? 30;
    const asOf = opts.asOf ?? new Date();
    const fromDate = new Date(asOf.getTime() - lookbackDays * 86_400_000);

    const signals = await this.db
      .select({
        id: analystSignal.id,
        workflowRunId: analystSignal.workflowRunId,
        agentInstanceId: analystSignal.agentInstanceId,
        analystRole: analystSignal.analystRole,
        ticker: analystSignal.ticker,
        signal: analystSignal.signal,
        createdAt: analystSignal.createdAt,
      })
      .from(analystSignal)
      .where(gte(analystSignal.createdAt, fromDate.toISOString()))
      .orderBy(asc(analystSignal.createdAt))
      .all();

    const result: SyncPlaceholdersResult = {
      scannedSignals: signals.length,
      placeholdersInserted: 0,
      alreadyExists: 0,
      skippedNoAgent: 0,
    };

    for (const s of signals) {
      const definitionId = await this.resolveDefinitionId(s.agentInstanceId);
      if (!definitionId) {
        result.skippedNoAgent += 1;
        continue;
      }
      const signalDate = dateToEpochDay(new Date(s.createdAt));

      const existing = await this.db
        .select({ id: analystAccuracyLog.id })
        .from(analystAccuracyLog)
        .where(
          and(
            eq(analystAccuracyLog.definitionId, definitionId),
            eq(analystAccuracyLog.ticker, s.ticker),
            eq(analystAccuracyLog.signalDate, signalDate)
          )
        )
        .get();
      if (existing) {
        result.alreadyExists += 1;
        continue;
      }

      await this.db
        .insert(analystAccuracyLog)
        .values({
          id: `aal_${randomUUID()}`,
          definitionId,
          ticker: s.ticker,
          signalDate,
          predictedSignal: s.signal,
          actualOutcome: null,
          isCorrect: null,
          evaluatedAt: null,
        })
        .run();
      result.placeholdersInserted += 1;
    }
    return result;
  }

  /** 阶段 B：回填 actualOutcome + isCorrect */
  async evaluatePending(opts: EvaluatePendingOptions = {}): Promise<EvaluatePendingResult> {
    const evalDelayDays = opts.evalDelayDays ?? 5;
    const upThreshold = opts.upThreshold ?? 0.02;
    const downThreshold = opts.downThreshold ?? -0.02;
    const asOf = opts.asOf ?? new Date();
    const getMarket = opts.getMarketForTicker ?? defaultTickerToMarket;

    const cutoffEpochDay = dateToEpochDay(asOf) - evalDelayDays;

    const pending = await this.db
      .select()
      .from(analystAccuracyLog)
      .where(
        and(
          isNull(analystAccuracyLog.isCorrect),
          lte(analystAccuracyLog.signalDate, cutoffEpochDay)
        )
      )
      .all();

    const result: EvaluatePendingResult = {
      scanned: pending.length,
      evaluated: 0,
      skippedNoMark: 0,
      skippedNoFutureMark: 0,
      failures: [],
    };

    for (const row of pending) {
      try {
        const market = getMarket(row.ticker);
        if (!market) {
          result.skippedNoMark += 1;
          continue;
        }
        // epochDayToDate 返回 UTC 00:00，在 America/New_York 是前一天 20:00，
        // dateToTradingDay 会算到前一日；加 12h 让探针落在 UTC 中午，跨已支持
        // market 时区（GMT−5 ~ GMT+8）都不会跨日。
        const signalDate = new Date(epochDayToDate(row.signalDate).getTime() + 12 * 3600 * 1000);
        const evalDate = nextNTradingDays(signalDate, evalDelayDays, market);

        // start 可回退至多 2 个交易日（信号日停牌容忍）；end 必须精确（评估日无数据 = 跳过，不污染推断）
        const startMark = await this.lookupMark(market, row.ticker, signalDate, {
          allowFallbackDays: 2,
        });
        const endMark = await this.lookupMark(market, row.ticker, evalDate, {
          allowFallbackDays: 0,
        });

        if (startMark === null) {
          result.skippedNoMark += 1;
          continue;
        }
        if (endMark === null) {
          result.skippedNoFutureMark += 1;
          continue;
        }

        const ret = (endMark - startMark) / startMark;
        let actualOutcome: "up" | "down" | "flat";
        if (ret > upThreshold) actualOutcome = "up";
        else if (ret < downThreshold) actualOutcome = "down";
        else actualOutcome = "flat";

        const isCorrect = computeIsCorrect(row.predictedSignal, actualOutcome) ? 1 : 0;

        await this.db
          .update(analystAccuracyLog)
          .set({
            actualOutcome,
            isCorrect,
            evaluatedAt: dateToEpochDay(asOf),
          })
          .where(eq(analystAccuracyLog.id, row.id))
          .run();
        result.evaluated += 1;
      } catch (err) {
        result.failures.push({
          id: row.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }

  /**
   * 取指定 trading_day 的 mark close。
   *
   * 行为：
   *   - allowFallbackDays = 0：仅取 trading_day 等于 asOfDate 的行；无则 null
   *   - allowFallbackDays > 0：允许向前回退最多 N 个日历天，取最近一条 ≤ asOfDate 的 close
   *
   * 调用方按需选 fallback：start 信号日（容忍停牌）允许回退；end 评估日必须精确，
   * 否则会把更早的 startMark 当成 endMark，污染 outcome 推断。
   */
  private async lookupMark(
    market: string,
    ticker: string,
    asOfDate: Date,
    opts: { allowFallbackDays: number }
  ): Promise<number | null> {
    const day = dateToTradingDay(asOfDate, market);
    if (opts.allowFallbackDays <= 0) {
      const row = await this.db
        .select({ close: dailyMarkPrice.close })
        .from(dailyMarkPrice)
        .where(
          and(
            eq(dailyMarkPrice.market, market),
            eq(dailyMarkPrice.symbol, ticker),
            eq(dailyMarkPrice.tradingDay, day)
          )
        )
        .get();
      return row?.close ?? null;
    }
    const earliestAllowed = dateToTradingDay(
      new Date(asOfDate.getTime() - opts.allowFallbackDays * 86_400_000),
      market
    );
    const row = await this.db
      .select({ close: dailyMarkPrice.close, tradingDay: dailyMarkPrice.tradingDay })
      .from(dailyMarkPrice)
      .where(
        and(
          eq(dailyMarkPrice.market, market),
          eq(dailyMarkPrice.symbol, ticker),
          lte(dailyMarkPrice.tradingDay, day),
          gte(dailyMarkPrice.tradingDay, earliestAllowed)
        )
      )
      .orderBy(desc(dailyMarkPrice.tradingDay))
      .limit(1)
      .get();
    return row?.close ?? null;
  }

  /**
   * 反查 agent_instance.definition_id；FK 严格语义：
   *   - agentInstanceId=null → 返回 null（caller 跳过）
   *   - agentInstanceId 在表中找不到 → 返回 null（caller 跳过）
   *
   * 这是 P4a 的保守策略：accuracy log 的 definition_id 是真实 agent_definition FK，
   * 不写假 id 避免污染 signal-fusion 的 loadDynamicWeights 聚合统计。
   */
  private async resolveDefinitionId(agentInstanceId: string | null): Promise<string | null> {
    if (!agentInstanceId) return null;
    const row = await this.db
      .select({ defId: sql<string>`definition_id` })
      .from(sql`agent_instance`)
      .where(sql`id = ${agentInstanceId}`)
      .get();
    return row?.defId ?? null;
  }
}

export function createAnalystAccuracyWriter(db: DbClient): AnalystAccuracyWriter {
  return new AnalystAccuracyWriter(db);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * 默认 ticker → market 推断（满足 80% 主流场景）。
 *   - '600000.SH' / '600000.SS' / '000001.SZ' → CN
 *   - '0700.HK' / '00700.HK' → HK
 *   - 纯字母（AAPL/MSFT/...） → US
 *   - 含 '/' 或 '-USD' → CRYPTO（BTC/USDT、BTC-USD）
 *   - 其他 → null（跳过评估）
 */
export function defaultTickerToMarket(ticker: string): string | null {
  const t = ticker.trim().toUpperCase();
  if (!t) return null;
  if (/\.(SH|SS|SZ|XSHG|XSHE)$/.test(t)) return "CN";
  if (/\.HK$/.test(t)) return "HK";
  if (t.includes("/") || /-USD[T]?$/.test(t) || /^(BTC|ETH|SOL|XRP|DOGE|BNB)$/.test(t)) {
    return "CRYPTO";
  }
  if (/^[A-Z]{1,5}$/.test(t)) return "US";
  return null;
}

/** 从给定 date 跳到第 N 个 trading_day 后的 Date（按 market 跳过周末） */
export function nextNTradingDays(start: Date, n: number, market: string): Date {
  let cursor = new Date(start.getTime());
  let count = 0;
  let safety = 0;
  while (count < n && safety < 30) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    safety += 1;
    if (!isWeekendInMarket(cursor, market)) count += 1;
  }
  return cursor;
}

/**
 * predicted vs actual 的对错判定：
 *   - buy  + up   → correct
 *   - sell + down → correct
 *   - hold + flat → correct
 *   - 其他组合 → incorrect
 */
export function computeIsCorrect(
  predicted: "buy" | "sell" | "hold",
  actual: "up" | "down" | "flat"
): boolean {
  if (predicted === "buy" && actual === "up") return true;
  if (predicted === "sell" && actual === "down") return true;
  if (predicted === "hold" && actual === "flat") return true;
  return false;
}
