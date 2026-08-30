/**
 * 事件驱动回测引擎（纯计算，不依赖 IO）
 *
 * 与设计文档 §8.1 对齐：
 *   - 多 symbol、多频率（先支持日线）
 *   - 横截面 topN 选股 + 等权重再平衡
 *   - 滑点 + 双边手续费
 *   - 市场微观结构冲击模型（Square-root / Volatility-adjusted）
 *   - 借券利率计提与不可做空限制
 *   - 下一根 open 撮合（标准事件驱动避免 lookahead）
 *
 * 输出：
 *   - equityCurve / trades / metrics
 */

import { computePerformanceMetrics } from "../../../backtest/performance-metrics";
import {
  contractNotional,
  type AssetLifecycleEvent,
  exposureToQuantity,
  fundingCashFlow,
  isExpired,
  normalizeInstrument,
} from "../../../backtest/asset-lifecycle-model";
import {
  closeFuturesContracts,
  futuresMarginRequirements,
  futuresPositionEquity,
  isFuturesInstrument,
  openFuturesContracts,
  settleFuturesPosition,
  type FuturesMarginPosition,
} from "../../../backtest/futures-margin-model";
import { calculateBlackScholesGreeks, yearsToExpiry } from "../../../backtest/option-risk-model";
import { assessOpenTradability } from "../../../backtest/market-tradability-model";
import {
  resolveFutureRollSymbol,
  rollSuccessorQuantity,
  shouldRollFuture,
} from "../../../backtest/futures-roll-model";
import {
  calculateDailyBorrowCost,
  calculateExecutionImpact,
} from "../../../backtest/market-impact-model";
import type {
  BacktestCosts,
  BacktestEquityPoint,
  BacktestMetrics,
  BacktestResult,
  BacktestTrade,
  BacktestInstrumentSpec,
} from "../../types";

export interface BarPoint {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  settlementPrice?: number;
  fundingRateBps?: number;
  impliedVolatility?: number;
  riskFreeRateAnnual?: number;
  tradable?: boolean;
  suspended?: boolean;
  priceLimitUp?: number;
  priceLimitDown?: number;
  calendarSession?: "open" | "closed";
}

export interface EngineInput {
  /** 升序交易日 */
  dates: string[];
  /** date → symbol → BarPoint */
  bars: Map<string, Map<string, BarPoint>>;
  /** date → symbol → 因子分数（null 表示该日该 symbol 不可交易/无信号） */
  signals: Map<string, Map<string, number | null>>;
  /** 资金 */
  capital: number;
  costs: BacktestCosts;
  rebalance: "daily" | "weekly" | "monthly";
  topN?: number;
  longShort: boolean;
  reverse: boolean;
  /** 基准 symbol（可选） */
  benchmarkSeries?: Array<{ date: string; close: number }>;
  /** 冻结的合约定义；衍生品的乘数、到期与资金费均从这里解析。 */
  instruments?: Record<string, BacktestInstrumentSpec>;
  /** Frequency-aware annualization denominator. */
  periodsPerYear?: number;
  /** Explicit corporate delisting settlements from the immutable action ledger. */
  delistings?: Array<{ symbol: string; effectiveDate: string; cashAmount?: number }>;
}

interface Position {
  symbol: string;
  /** 正数为多头、负数为空头。 */
  qty: number;
  avgPrice: number;
  /** 缺 bar 时沿用最后一个可交易收盘价估值，避免仓位凭空归零。 */
  lastMark: number;
  /** 仅期货使用；权益由保证金余额与逐日盯市 PnL 构成，不是 qty × price。 */
  futuresMargin?: FuturesMarginPosition;
}

function isRebalanceSession(
  timestamp: string,
  lastRebalanceTimestamp: string | null,
  freq: "daily" | "weekly" | "monthly"
): boolean {
  if (!lastRebalanceTimestamp) return true;
  const cur = new Date(timestamp);
  const prev = new Date(lastRebalanceTimestamp);
  if (freq === "daily") {
    return cur.toISOString().slice(0, 10) !== prev.toISOString().slice(0, 10);
  }
  if (freq === "weekly") {
    const cw = isoWeek(cur);
    const pw = isoWeek(prev);
    return cw !== pw;
  }
  return cur.getUTCMonth() !== prev.getUTCMonth() || cur.getUTCFullYear() !== prev.getUTCFullYear();
}

function isoWeek(d: Date): string {
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  const weekNum = 1 + Math.ceil((firstThursday - target.valueOf()) / 604_800_000);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function pickHoldings(
  scoresByDate: Map<string, number | null>,
  topN: number | undefined,
  longShort: boolean,
  reverse: boolean
): { longs: string[]; shorts: string[] } {
  const entries: Array<{ symbol: string; score: number }> = [];
  for (const [sym, sc] of scoresByDate.entries()) {
    if (sc == null || !Number.isFinite(sc)) continue;
    entries.push({ symbol: sym, score: reverse ? -sc : sc });
  }
  if (entries.length === 0) return { longs: [], shorts: [] };
  entries.sort((a, b) => b.score - a.score);

  if (topN && topN > 0 && topN < entries.length) {
    const longs = entries.slice(0, topN).map((e) => e.symbol);
    const shortCount = longShort
      ? Math.min(topN, Math.floor((entries.length - longs.length) / 1))
      : 0;
    const shorts =
      longShort && shortCount > 0 ? entries.slice(-shortCount).map((e) => e.symbol) : [];
    return { longs, shorts };
  }
  if (longShort) {
    const longs = entries.filter((e) => e.score > 0).map((e) => e.symbol);
    const shorts = entries.filter((e) => e.score < 0).map((e) => e.symbol);
    return { longs, shorts };
  }
  return { longs: entries.map((e) => e.symbol), shorts: [] };
}

function computeMetrics(
  equityCurve: BacktestEquityPoint[],
  trades: BacktestTrade[],
  initialCapital: number,
  periodsPerYear?: number
): BacktestMetrics {
  const metrics = computePerformanceMetrics({
    equityCurve,
    trades,
    initialCapital,
    periodsPerYear,
  });
  return {
    ...metrics,
    winRate: metrics.positivePeriodRate,
  };
}

function getEffectiveExecution(
  sym: string,
  side: "buy" | "sell",
  px: number,
  qty: number,
  bar: BarPoint | undefined,
  costs: BacktestCosts
): { fillPx: number; fillQty: number } {
  if (costs.slippageModel && costs.slippageModel !== "fixed_bps") {
    const defaultBar: BarPoint = bar ?? {
      open: px,
      high: px,
      low: px,
      close: px,
      volume: 1_000_000,
    };
    const impact = calculateExecutionImpact({
      symbol: sym,
      side,
      nominalPrice: px,
      qty,
      bar: defaultBar,
      config: {
        model: costs.slippageModel,
        baseSlippageBps: costs.slippageBps,
        ...(costs.impactCoefficient !== undefined
          ? { impactCoefficient: costs.impactCoefficient }
          : {}),
        ...(costs.maxVolumeParticipation !== undefined
          ? { maxVolumeParticipation: costs.maxVolumeParticipation }
          : {}),
        ...(costs.borrowRateAnnualBps !== undefined
          ? { borrowRateAnnualBps: costs.borrowRateAnnualBps }
          : {}),
        ...(costs.restrictedShortSymbols
          ? { restrictedShortSymbols: costs.restrictedShortSymbols }
          : {}),
      },
    });
    return {
      fillPx: impact.effectivePrice,
      fillQty: impact.actualFilledQty,
    };
  }
  const slipRate = costs.slippageBps / 10_000;
  const fillPx = side === "buy" ? px * (1 + slipRate) : px * (1 - slipRate);
  return { fillPx, fillQty: qty };
}

function positionEquityAt(
  position: Position,
  price: number,
  instruments: Record<string, BacktestInstrumentSpec> | undefined
): number {
  const spec = normalizeInstrument(position.symbol, instruments);
  if (isFuturesInstrument(spec) && position.futuresMargin) {
    return futuresPositionEquity(position.futuresMargin, price, spec);
  }
  return contractNotional(position.qty, price, spec);
}

function recordUnfilledTradability(
  events: AssetLifecycleEvent[],
  date: string,
  symbol: string,
  reason: string
): void {
  events.push({ date, symbol, kind: "order_unfilled_tradability", amount: 0, detail: reason });
}

function rebalanceFutureToTarget(input: {
  symbol: string;
  targetQty: number;
  bar: BarPoint;
  date: string;
  spec: ReturnType<typeof normalizeInstrument>;
  costs: BacktestCosts;
  commissionRate: number;
  cash: number;
  positions: Map<string, Position>;
  trades: BacktestTrade[];
  assetLifecycleEvents: AssetLifecycleEvent[];
}): number {
  const {
    symbol,
    targetQty,
    bar,
    date,
    spec,
    costs,
    commissionRate,
    positions,
    trades,
    assetLifecycleEvents,
  } = input;
  let cash = input.cash;
  let current = positions.get(symbol);
  const currentQty = current?.qty ?? 0;
  const delta = targetQty - currentQty;
  if (Math.abs(delta) < 1e-9) return cash;
  const side: "buy" | "sell" = delta > 0 ? "buy" : "sell";
  const tradability = assessOpenTradability(bar, side);
  if (!tradability.executable) {
    assetLifecycleEvents.push({
      date,
      symbol,
      kind: "order_unfilled_tradability",
      amount: 0,
      detail: tradability.reason,
    });
    return cash;
  }
  const execution = getEffectiveExecution(symbol, side, bar.open, Math.abs(delta), bar, costs);
  if (execution.fillQty < 1e-9) return cash;
  let remainingFill = execution.fillQty;

  // First flatten any exposure in the opposite direction, then add new contracts if required.
  if (current && Math.sign(delta) !== Math.sign(current.qty)) {
    const closeQty = Math.min(remainingFill, Math.abs(current.qty));
    const close = closeFuturesContracts(
      current.futuresMargin ?? {
        qty: current.qty,
        marginBalance: 0,
        settlementPrice: current.lastMark,
      },
      closeQty,
      execution.fillPx,
      spec
    );
    const closeNotional = Math.abs(contractNotional(closeQty, execution.fillPx, spec));
    const fee = Math.max(closeNotional * commissionRate, costs.minCommission ?? 0);
    cash += close.cashDelta - fee;
    trades.push({ date, symbol, side, qty: closeQty, price: execution.fillPx, commission: fee });
    remainingFill -= closeQty;
    if (close.position) {
      positions.set(symbol, {
        ...current,
        qty: close.position.qty,
        lastMark: execution.fillPx,
        futuresMargin: close.position,
      });
      return cash;
    }
    positions.delete(symbol);
    current = undefined;
  }

  if (remainingFill < 1e-9) return cash;
  const signedFill = (side === "buy" ? 1 : -1) * remainingFill;
  const opened = openFuturesContracts(current?.futuresMargin, signedFill, execution.fillPx, spec);
  const notional = Math.abs(contractNotional(remainingFill, execution.fillPx, spec));
  const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
  if (cash + opened.cashDelta - fee < -1e-9) return cash;
  cash += opened.cashDelta - fee;
  positions.set(symbol, {
    symbol,
    qty: opened.position.qty,
    avgPrice: opened.position.settlementPrice,
    lastMark: execution.fillPx,
    futuresMargin: opened.position,
  });
  trades.push({ date, symbol, side, qty: remainingFill, price: execution.fillPx, commission: fee });
  return cash;
}

function rollFuturesAtOpen(input: {
  date: string;
  barsToday: Map<string, BarPoint>;
  instruments?: Record<string, BacktestInstrumentSpec>;
  costs: BacktestCosts;
  commissionRate: number;
  cash: number;
  positions: Map<string, Position>;
  trades: BacktestTrade[];
  assetLifecycleEvents: AssetLifecycleEvent[];
}): number {
  const {
    date,
    barsToday,
    instruments,
    costs,
    commissionRate,
    positions,
    trades,
    assetLifecycleEvents,
  } = input;
  let cash = input.cash;
  for (const [symbol, position] of [...positions]) {
    const spec = instruments?.[symbol];
    if (!shouldRollFuture(spec, date)) continue;
    const successorSymbol = spec.futureRoll.successorSymbol.trim();
    const oldBar = barsToday.get(symbol);
    const successorBar = barsToday.get(successorSymbol);
    if (!oldBar || !successorBar) {
      assetLifecycleEvents.push({
        date,
        symbol,
        kind: "futures_roll",
        amount: 0,
        detail: `unfilled_missing_roll_bar:${symbol}->${successorSymbol}`,
      });
      continue;
    }
    const oldQty = position.qty;
    const oldNotional = Math.abs(
      contractNotional(oldQty, oldBar.open, normalizeInstrument(symbol, instruments))
    );
    cash = rebalanceFutureToTarget({
      symbol,
      targetQty: 0,
      bar: oldBar,
      date,
      spec: normalizeInstrument(symbol, instruments),
      costs,
      commissionRate,
      cash,
      positions,
      trades,
      assetLifecycleEvents,
    });
    if (positions.has(symbol)) {
      assetLifecycleEvents.push({
        date,
        symbol,
        kind: "futures_roll",
        amount: oldNotional,
        detail: `unfilled_close:${symbol}->${successorSymbol}`,
      });
      continue;
    }

    const successorSpec = normalizeInstrument(successorSymbol, instruments);
    const qty = rollSuccessorQuantity({
      oldQuantity: oldQty,
      oldMultiplier: normalizeInstrument(symbol, instruments).contractMultiplier,
      successorMultiplier: successorSpec.contractMultiplier,
      ...(successorSpec.lotSize ? { successorLotSize: successorSpec.lotSize } : {}),
    });
    if (Math.abs(qty) < 1e-9) {
      assetLifecycleEvents.push({
        date,
        symbol,
        kind: "futures_roll",
        amount: oldNotional,
        detail: `unfilled_zero_successor_quantity:${symbol}->${successorSymbol}`,
      });
      continue;
    }
    cash = rebalanceFutureToTarget({
      symbol: successorSymbol,
      targetQty: qty,
      bar: successorBar,
      date,
      spec: successorSpec,
      costs,
      commissionRate,
      cash,
      positions,
      trades,
      assetLifecycleEvents,
    });
    assetLifecycleEvents.push({
      date,
      symbol,
      kind: "futures_roll",
      amount: oldNotional,
      detail: positions.has(successorSymbol)
        ? `rolled:${symbol}->${successorSymbol}`
        : `unfilled_open:${symbol}->${successorSymbol}`,
    });
  }
  return cash;
}

function isDelisted(
  symbol: string,
  date: string,
  delistings: ReadonlyArray<{ symbol: string; effectiveDate: string }>
): boolean {
  return delistings.some(
    (event) => event.symbol === symbol && event.effectiveDate <= date.slice(0, 10)
  );
}

/**
 * A delisting is not an ordinary market order: the corporate-action ledger
 * supplies the settlement event, so it bypasses daily tradability flags but
 * still uses a frozen cash settlement or opening price and always leaves an
 * audit trade. This prevents a vanished symbol from being silently marked at
 * its stale last price forever.
 */
function settleDelistingsAtOpen(input: {
  date: string;
  delistings: ReadonlyArray<{ symbol: string; effectiveDate: string; cashAmount?: number }>;
  barsToday: Map<string, BarPoint>;
  instruments?: Record<string, BacktestInstrumentSpec>;
  costs: BacktestCosts;
  commissionRate: number;
  cash: number;
  positions: Map<string, Position>;
  trades: BacktestTrade[];
  assetLifecycleEvents: AssetLifecycleEvent[];
}): number {
  let cash = input.cash;
  for (const event of input.delistings) {
    if (event.effectiveDate !== input.date.slice(0, 10)) continue;
    const position = input.positions.get(event.symbol);
    if (!position) continue;
    const bar = input.barsToday.get(event.symbol);
    const settlementPrice =
      Number.isFinite(event.cashAmount) && (event.cashAmount ?? 0) >= 0
        ? (event.cashAmount as number)
        : bar?.open;
    if (!Number.isFinite(settlementPrice) || settlementPrice === undefined) {
      input.assetLifecycleEvents.push({
        date: input.date,
        symbol: event.symbol,
        kind: "delisting_settlement",
        amount: 0,
        detail: "unsettled_missing_frozen_delisting_price",
      });
      continue;
    }
    const spec = normalizeInstrument(event.symbol, input.instruments);
    const qty = Math.abs(position.qty);
    const side: "buy" | "sell" = position.qty > 0 ? "sell" : "buy";
    const notional = Math.abs(contractNotional(qty, settlementPrice, spec));
    const fee = Math.max(notional * input.commissionRate, input.costs.minCommission ?? 0);
    const cashDelta = position.qty > 0 ? notional - fee : -notional - fee;
    cash += cashDelta;
    input.trades.push({
      date: input.date,
      symbol: event.symbol,
      side,
      qty,
      price: settlementPrice,
      commission: fee,
    });
    input.positions.delete(event.symbol);
    input.assetLifecycleEvents.push({
      date: input.date,
      symbol: event.symbol,
      kind: "delisting_settlement",
      amount: cashDelta,
      detail:
        event.cashAmount !== undefined
          ? "cash settlement from immutable corporate-action delisting ledger"
          : "opening-price settlement from immutable delisting-date bar",
    });
  }
  return cash;
}

export function runEventEngine(input: EngineInput): BacktestResult {
  const t0 = Date.now();
  const {
    dates,
    bars,
    signals,
    capital,
    costs,
    rebalance,
    topN,
    longShort,
    reverse,
    benchmarkSeries,
    instruments,
    delistings = [],
    periodsPerYear,
  } = input;

  const equityCurve: BacktestEquityPoint[] = [];
  const trades: BacktestTrade[] = [];
  const assetLifecycleEvents: AssetLifecycleEvent[] = [];
  let cash = capital;
  const positions = new Map<string, Position>();
  let targets: { longs: string[]; shorts: string[] } = { longs: [], shorts: [] };
  let prevRebalanceDate: string | null = null;
  let skippedDays = 0;

  const commissionRate = costs.commissionBps / 10_000;

  const benchMap = new Map<string, number>();
  if (benchmarkSeries) {
    for (const p of benchmarkSeries) benchMap.set(p.date, p.close);
  }
  let benchBase: number | null = null;

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di]!;
    const barsToday = bars.get(date);
    if (!barsToday) continue;
    const sessionDate = date.slice(0, 10);

    cash = rollFuturesAtOpen({
      date: sessionDate,
      barsToday,
      instruments,
      costs,
      commissionRate,
      cash,
      positions,
      trades,
      assetLifecycleEvents,
    });
    cash = settleDelistingsAtOpen({
      date,
      delistings,
      barsToday,
      instruments,
      costs,
      commissionRate,
      cash,
      positions,
      trades,
      assetLifecycleEvents,
    });

    // 1) 先按 yesterday 的 targets 在 today open 撮合：换仓
    //    触发条件：再平衡日 OR 首次入场（positions 仍空但已有 targets）
    const isFirstEntry = positions.size === 0;
    if (
      di > 0 &&
      // Targets are produced by the previous bar and executed at this bar's
      // open. Therefore the rebalance clock follows that signal bar, never
      // the execution bar itself.
      (isFirstEntry || isRebalanceSession(dates[di - 1]!, prevRebalanceDate, rebalance)) &&
      (targets.longs.length > 0 || targets.shorts.length > 0 || positions.size > 0)
    ) {
      // 计算当前组合市值（用今日 open）
      let equityAtOpen = cash;
      for (const pos of positions.values()) {
        const px = barsToday.get(pos.symbol)?.open ?? pos.lastMark;
        equityAtOpen += positionEquityAt(pos, px, instruments);
      }
      const activeLongs = Array.from(
        new Set(
          targets.longs
            .map((symbol) => resolveFutureRollSymbol(symbol, sessionDate, instruments))
            .filter(
              (symbol) =>
                !isExpired(normalizeInstrument(symbol, instruments), sessionDate) &&
                !isDelisted(symbol, date, delistings)
            )
        )
      );
      const activeShorts = Array.from(
        new Set(
          targets.shorts
            .map((symbol) => resolveFutureRollSymbol(symbol, sessionDate, instruments))
            .filter(
              (symbol) =>
                !isExpired(normalizeInstrument(symbol, instruments), sessionDate) &&
                !isDelisted(symbol, date, delistings)
            )
        )
      );
      const allTargets = new Set([...activeLongs, ...activeShorts]);
      const longCount = activeLongs.length;
      const shortCount = activeShorts.length;
      const totalSlots = longCount + shortCount;
      const perSlot = totalSlots > 0 ? equityAtOpen / totalSlots : 0;

      // 平仓非目标
      for (const [sym, pos] of positions) {
        if (allTargets.has(sym)) continue;
        // 到期合约必须走当日官方结算价，不能被普通再平衡提前按 open 平仓。
        if (isExpired(normalizeInstrument(sym, instruments), sessionDate)) continue;
        const curBar = barsToday.get(sym);
        const openPx = curBar?.open;
        if (openPx == null) continue;
        const qty = Math.abs(pos.qty);
        const side = pos.qty > 0 ? "sell" : "buy";
        const spec = normalizeInstrument(sym, instruments);
        if (isFuturesInstrument(spec)) {
          cash = rebalanceFutureToTarget({
            symbol: sym,
            targetQty: 0,
            bar: curBar ?? {
              open: pos.lastMark,
              high: pos.lastMark,
              low: pos.lastMark,
              close: pos.lastMark,
              volume: 0,
            },
            date,
            spec,
            costs,
            commissionRate,
            cash,
            positions,
            trades,
            assetLifecycleEvents,
          });
          continue;
        }
        const tradability = assessOpenTradability(curBar, side);
        if (!tradability.executable) {
          recordUnfilledTradability(assetLifecycleEvents, date, sym, tradability.reason);
          continue;
        }
        const { fillPx, fillQty } = getEffectiveExecution(sym, side, openPx, qty, curBar, costs);
        if (fillQty < 1e-9) continue;

        if (pos.qty > 0) {
          const notional = contractNotional(fillQty, fillPx, spec);
          const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
          cash += notional - fee;
          trades.push({
            date,
            symbol: sym,
            side: "sell",
            qty: fillQty,
            price: fillPx,
            commission: fee,
          });
        } else {
          const notional = contractNotional(fillQty, fillPx, spec);
          const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
          cash -= notional + fee;
          trades.push({
            date,
            symbol: sym,
            side: "buy",
            qty: fillQty,
            price: fillPx,
            commission: fee,
          });
        }
        positions.delete(sym);
      }

      // 调仓到目标（先处理 longs，再处理 shorts）
      for (const sym of activeLongs) {
        const curBar = barsToday.get(sym);
        const px = curBar?.open;
        if (px == null) continue;
        const targetMV = perSlot;
        const cur = positions.get(sym);
        const spec = normalizeInstrument(sym, instruments);
        if (isFuturesInstrument(spec)) {
          cash = rebalanceFutureToTarget({
            symbol: sym,
            targetQty: exposureToQuantity(targetMV * (spec.targetLeverage ?? 1), px, spec),
            bar: curBar,
            date,
            spec,
            costs,
            commissionRate,
            cash,
            positions,
            trades,
            assetLifecycleEvents,
          });
          continue;
        }
        const curMV = cur ? contractNotional(cur.qty, px, spec) : 0;
        const delta = targetMV - curMV;
        if (Math.abs(delta) < equityAtOpen * 0.001) continue;
        const side = delta > 0 ? "buy" : "sell";
        const rawQty = exposureToQuantity(Math.abs(delta), px, spec);
        const tradability = assessOpenTradability(curBar, side);
        if (!tradability.executable) {
          recordUnfilledTradability(assetLifecycleEvents, date, sym, tradability.reason);
          continue;
        }
        const { fillPx, fillQty } = getEffectiveExecution(sym, side, px, rawQty, curBar, costs);

        if (side === "buy") {
          const budget = Math.min(
            contractNotional(fillQty, fillPx, spec),
            maxAffordableBuyNotional(cash, commissionRate, costs.minCommission ?? 0)
          );
          if (budget <= 0) continue;
          const actualQty = exposureToQuantity(budget, fillPx, spec);
          if (actualQty < 1e-9) continue;
          const notional = contractNotional(actualQty, fillPx, spec);
          const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
          cash -= notional + fee;
          const newQty = (cur?.qty ?? 0) + actualQty;
          const newAvg =
            newQty > 0
              ? (cur?.qty ?? 0) > 0
                ? ((cur?.qty ?? 0) * (cur?.avgPrice ?? 0) + actualQty * fillPx) / newQty
                : fillPx
              : 0;
          positions.set(sym, { symbol: sym, qty: newQty, avgPrice: newAvg, lastMark: fillPx });
          trades.push({
            date,
            symbol: sym,
            side: "buy",
            qty: actualQty,
            price: fillPx,
            commission: fee,
          });
        } else {
          const actualQty = Math.min(cur?.qty ?? 0, fillQty);
          if (actualQty < 1e-9) continue;
          const notional = contractNotional(actualQty, fillPx, spec);
          const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
          cash += notional - fee;
          const remaining = (cur?.qty ?? 0) - actualQty;
          if (remaining > 1e-9) {
            positions.set(sym, {
              symbol: sym,
              qty: remaining,
              avgPrice: cur?.avgPrice ?? fillPx,
              lastMark: fillPx,
            });
          } else {
            positions.delete(sym);
          }
          trades.push({
            date,
            symbol: sym,
            side: "sell",
            qty: actualQty,
            price: fillPx,
            commission: fee,
          });
        }
      }

      // 空头目标采用 signed quantity；与多头一样以开盘成交、计入滑点和手续费。
      for (const sym of activeShorts) {
        if (costs.restrictedShortSymbols?.includes(sym)) continue;
        const curBar = barsToday.get(sym);
        const px = curBar?.open;
        if (px == null) continue;
        const targetMV = -perSlot;
        const cur = positions.get(sym);
        const spec = normalizeInstrument(sym, instruments);
        if (isFuturesInstrument(spec)) {
          cash = rebalanceFutureToTarget({
            symbol: sym,
            targetQty: -exposureToQuantity(
              Math.abs(targetMV) * (spec.targetLeverage ?? 1),
              px,
              spec
            ),
            bar: curBar,
            date,
            spec,
            costs,
            commissionRate,
            cash,
            positions,
            trades,
            assetLifecycleEvents,
          });
          continue;
        }
        const curMV = cur ? contractNotional(cur.qty, px, spec) : 0;
        const delta = targetMV - curMV;
        if (Math.abs(delta) < equityAtOpen * 0.001) continue;

        if (delta < 0) {
          const rawQty = exposureToQuantity(Math.abs(delta), px, spec);
          const tradability = assessOpenTradability(curBar, "sell");
          if (!tradability.executable) {
            recordUnfilledTradability(assetLifecycleEvents, date, sym, tradability.reason);
            continue;
          }
          const { fillPx, fillQty } = getEffectiveExecution(sym, "sell", px, rawQty, curBar, costs);
          if (fillQty < 1e-9) continue;
          const notional = contractNotional(fillQty, fillPx, spec);
          const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
          cash += notional - fee;
          const newQty = (cur?.qty ?? 0) - fillQty;
          positions.set(sym, {
            symbol: sym,
            qty: newQty,
            avgPrice: newQty < 0 ? fillPx : (cur?.avgPrice ?? fillPx),
            lastMark: fillPx,
          });
          trades.push({
            date,
            symbol: sym,
            side: "sell",
            qty: fillQty,
            price: fillPx,
            commission: fee,
          });
        } else {
          const rawQty = exposureToQuantity(delta, px, spec);
          const tradability = assessOpenTradability(curBar, "buy");
          if (!tradability.executable) {
            recordUnfilledTradability(assetLifecycleEvents, date, sym, tradability.reason);
            continue;
          }
          const { fillPx, fillQty } = getEffectiveExecution(sym, "buy", px, rawQty, curBar, costs);
          const budget = Math.min(
            contractNotional(fillQty, fillPx, spec),
            maxAffordableBuyNotional(cash, commissionRate, costs.minCommission ?? 0)
          );
          if (budget <= 0) continue;
          const actualQty = exposureToQuantity(budget, fillPx, spec);
          if (actualQty < 1e-9) continue;
          const notional = contractNotional(actualQty, fillPx, spec);
          const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
          cash -= notional + fee;
          const newQty = (cur?.qty ?? 0) + actualQty;
          if (Math.abs(newQty) <= 1e-9) positions.delete(sym);
          else {
            positions.set(sym, {
              symbol: sym,
              qty: newQty,
              avgPrice: cur?.avgPrice ?? fillPx,
              lastMark: fillPx,
            });
          }
          trades.push({
            date,
            symbol: sym,
            side: "buy",
            qty: actualQty,
            price: fillPx,
            commission: fee,
          });
        }
      }
      prevRebalanceDate = dates[di - 1]!;
    } else if (di === 0) {
      prevRebalanceDate = date;
    }

    // 2) 当日信号 → 下一次再平衡的 targets（在生成 signals 时记录）
    const sigToday = signals.get(date);
    if (sigToday) {
      const picks = pickHoldings(sigToday, topN, longShort, reverse);
      if (picks.longs.length === 0 && picks.shorts.length === 0) {
        skippedDays++;
      }
      targets = picks;
    } else {
      skippedDays++;
    }

    // 3) 借券利息计提（融券利息每日计算）
    if (costs.borrowRateAnnualBps && costs.borrowRateAnnualBps > 0) {
      let shortNotional = 0;
      for (const pos of positions.values()) {
        if (pos.qty < 0 && !isFuturesInstrument(normalizeInstrument(pos.symbol, instruments))) {
          shortNotional += Math.abs(
            contractNotional(pos.qty, pos.lastMark, normalizeInstrument(pos.symbol, instruments))
          );
        }
      }
      if (shortNotional > 0) {
        const borrowFee = calculateDailyBorrowCost(shortNotional, costs.borrowRateAnnualBps, 1);
        cash -= borrowFee;
      }
    }

    // 4) 永续资金费：费率属于不可变行情 Bar，正费率由多头支付、空头收取。
    for (const pos of positions.values()) {
      const bar = barsToday.get(pos.symbol);
      if (!bar) continue;
      const funding = fundingCashFlow(
        pos.qty,
        bar.close,
        bar.fundingRateBps,
        normalizeInstrument(pos.symbol, instruments)
      );
      cash += funding;
      if (funding !== 0) {
        assetLifecycleEvents.push({
          date,
          symbol: pos.symbol,
          kind: "perpetual_funding",
          amount: funding,
          detail: "snapshot fundingRateBps applied to perpetual position",
        });
      }
    }

    // 5) 期权风险快照：价格/成交仍使用冻结 option Bar；Black–Scholes 只用于暴露审计，
    // 不会用理论价替换实际成交价。必须同时拥有同快照标的、IV 与无风险利率。
    for (const pos of positions.values()) {
      const spec = normalizeInstrument(pos.symbol, instruments);
      if (
        spec.assetClass !== "option" ||
        !spec.underlyingSymbol ||
        !spec.optionRight ||
        !spec.strike ||
        !spec.expiryDate ||
        isExpired(spec, sessionDate)
      ) {
        continue;
      }
      const optionBar = barsToday.get(pos.symbol);
      const underlyingBar = barsToday.get(spec.underlyingSymbol);
      if (
        !optionBar ||
        !underlyingBar ||
        !(optionBar.impliedVolatility && optionBar.impliedVolatility > 0) ||
        optionBar.riskFreeRateAnnual === undefined
      ) {
        continue;
      }
      const timeToExpiryYears = yearsToExpiry(date, spec.expiryDate);
      const risk = calculateBlackScholesGreeks({
        right: spec.optionRight,
        spot: underlyingBar.close,
        strike: spec.strike,
        timeToExpiryYears,
        impliedVolatility: optionBar.impliedVolatility,
        riskFreeRateAnnual: optionBar.riskFreeRateAnnual,
      });
      if (!risk) continue;
      const signedMultiplier = pos.qty * spec.contractMultiplier;
      assetLifecycleEvents.push({
        date,
        symbol: pos.symbol,
        kind: "option_greeks_snapshot",
        amount: risk.theoreticalPrice * signedMultiplier,
        detail: "Black–Scholes exposure audit from immutable underlying, IV, and rate snapshot",
        optionRisk: {
          underlyingPrice: underlyingBar.close,
          impliedVolatility: optionBar.impliedVolatility,
          riskFreeRateAnnual: optionBar.riskFreeRateAnnual,
          timeToExpiryYears,
          delta: risk.delta * signedMultiplier,
          gamma: risk.gamma * signedMultiplier,
          thetaPerDay: risk.thetaPerDay * signedMultiplier,
          vegaPerPoint: risk.vegaPerPoint * signedMultiplier,
        },
      });
    }

    // 6) 期货逐日盯市与保证金检查。variation PnL 进入保证金余额；跌破维持保证金
    // 时先补回初始保证金，现金不足则在同一结算价强平并留下审计事件。
    for (const [sym, pos] of positions) {
      const spec = normalizeInstrument(sym, instruments);
      if (!isFuturesInstrument(spec) || !pos.futuresMargin) continue;
      const bar = barsToday.get(sym);
      if (!bar) continue;
      const settlePx = bar.settlementPrice ?? bar.close;
      const settled = settleFuturesPosition(pos.futuresMargin, settlePx, spec);
      pos.futuresMargin = settled.position;
      pos.lastMark = settlePx;
      pos.avgPrice = settled.position.settlementPrice;
      if (settled.variationPnl !== 0) {
        assetLifecycleEvents.push({
          date,
          symbol: sym,
          kind: "futures_variation_margin",
          amount: settled.variationPnl,
          detail: "daily variation margin settled from immutable snapshot settlement price",
        });
      }
      const requirements = futuresMarginRequirements(pos.qty, settlePx, spec);
      if (settled.position.marginBalance < requirements.maintenance) {
        const topUp = Math.max(0, requirements.initial - settled.position.marginBalance);
        if (cash >= topUp) {
          cash -= topUp;
          settled.position.marginBalance += topUp;
          assetLifecycleEvents.push({
            date,
            symbol: sym,
            kind: "futures_margin_call",
            amount: -topUp,
            detail: "margin replenished from free cash to initial requirement",
          });
        } else {
          const qty = Math.abs(pos.qty);
          const side: "buy" | "sell" = pos.qty > 0 ? "sell" : "buy";
          const notional = Math.abs(contractNotional(qty, settlePx, spec));
          const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
          cash += settled.position.marginBalance - fee;
          trades.push({ date, symbol: sym, side, qty, price: settlePx, commission: fee });
          positions.delete(sym);
          assetLifecycleEvents.push({
            date,
            symbol: sym,
            kind: "futures_forced_liquidation",
            amount: settled.position.marginBalance - fee,
            detail: "maintenance margin breached and free cash could not restore initial margin",
          });
          continue;
        }
      }
      if (isExpired(spec, sessionDate)) {
        const qty = Math.abs(pos.qty);
        const side: "buy" | "sell" = pos.qty > 0 ? "sell" : "buy";
        const notional = Math.abs(contractNotional(qty, settlePx, spec));
        const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
        cash += settled.position.marginBalance - fee;
        trades.push({ date, symbol: sym, side, qty, price: settlePx, commission: fee });
        positions.delete(sym);
        assetLifecycleEvents.push({
          date,
          symbol: sym,
          kind: "expiry_settlement",
          amount: settled.position.marginBalance - fee,
          detail: "cash-settled futures contract closed at expiry settlement price",
        });
      }
    }

    // 7) 到期现金结算。使用快照内官方 settlementPrice，缺省时按 close 退化，
    // 该退化会在 assetLifecycleReport 中保持 research_only 标识。
    for (const [sym, pos] of positions) {
      const spec = normalizeInstrument(sym, instruments);
      if (isFuturesInstrument(spec)) continue;
      if (!isExpired(spec, sessionDate)) continue;
      const bar = barsToday.get(sym);
      if (!bar) continue;
      const settlePx = bar.settlementPrice ?? bar.close;
      const side = pos.qty > 0 ? "sell" : "buy";
      const qty = Math.abs(pos.qty);
      const notional = contractNotional(qty, settlePx, spec);
      const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
      cash += pos.qty > 0 ? notional - fee : -notional - fee;
      trades.push({ date, symbol: sym, side, qty, price: settlePx, commission: fee });
      positions.delete(sym);
      assetLifecycleEvents.push({
        date,
        symbol: sym,
        kind: "expiry_settlement",
        amount: pos.qty > 0 ? notional - fee : -notional - fee,
        detail: "cash-settled contract closed at expiry settlement price",
      });
    }

    // 8) 用当日 close 估值 → equity 曲线
    let mtmEquity = cash;
    for (const pos of positions.values()) {
      const px = barsToday.get(pos.symbol)?.close ?? pos.lastMark;
      pos.lastMark = px;
      mtmEquity += positionEquityAt(pos, px, instruments);
    }
    const point: BacktestEquityPoint = { date, equity: mtmEquity };
    if (benchMap.size > 0) {
      const bc = benchMap.get(date);
      if (bc != null) {
        if (benchBase == null) benchBase = bc;
        point.benchmarkEquity = (bc / benchBase) * capital;
      }
    }
    equityCurve.push(point);
  }

  const metrics = computeMetrics(equityCurve, trades, capital, periodsPerYear);
  return {
    equityCurve,
    trades,
    metrics,
    meta: {
      latencyMs: Date.now() - t0,
      sampleSize: equityCurve.length,
      barCount: Array.from(bars.values()).reduce((s, m) => s + m.size, 0),
      ...(periodsPerYear ? { periodsPerYear } : {}),
      skippedDays,
      ...(assetLifecycleEvents.length > 0 ? { assetLifecycleEvents } : {}),
    },
  };
}

/** 满足 notional + max(notional * commissionRate, minCommission) <= cash 的最大可买名义金额。 */
function maxAffordableBuyNotional(
  cash: number,
  commissionRate: number,
  minCommission: number
): number {
  if (!Number.isFinite(cash) || cash <= 0) return 0;
  // 避免零成本时二分逼近得到 cash-ε，随后按整手向下取整少买一手。
  if (commissionRate <= 0 && minCommission <= 0) return cash;
  let low = 0;
  let high = cash;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    const fee = Math.max(mid * commissionRate, minCommission);
    if (mid + fee <= cash) low = mid;
    else high = mid;
  }
  return low;
}
