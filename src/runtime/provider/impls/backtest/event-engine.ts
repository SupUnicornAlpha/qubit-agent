/**
 * 事件驱动回测引擎（纯计算，不依赖 IO）
 *
 * 与设计文档 §8.1 对齐：
 *   - 多 symbol、多频率（先支持日线）
 *   - 横截面 topN 选股 + 等权重再平衡
 *   - 滑点 + 双边手续费
 *   - 下一根 open 撮合（标准事件驱动避免 lookahead）
 *
 * 输入约定：
 *   - bars：{date → symbol → {open, high, low, close, ...}}，已对齐到交易日
 *   - signals：{date → symbol → score | null}（横截面 score；null 表示无信号）
 *
 * 输出：
 *   - equityCurve / trades / metrics
 */

import type {
  BacktestCosts,
  BacktestEquityPoint,
  BacktestMetrics,
  BacktestResult,
  BacktestTrade,
} from "../../types";

export interface BarPoint {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
}

interface Position {
  symbol: string;
  qty: number;
  avgPrice: number;
}

function isRebalanceDay(
  date: string,
  prevDate: string | null,
  freq: "daily" | "weekly" | "monthly"
): boolean {
  if (freq === "daily") return true;
  if (!prevDate) return true;
  const cur = new Date(date + "T00:00:00Z");
  const prev = new Date(prevDate + "T00:00:00Z");
  if (freq === "weekly") {
    // ISO 周不同 → 再平衡
    const cw = isoWeek(cur);
    const pw = isoWeek(prev);
    return cw !== pw;
  }
  // monthly
  return cur.getUTCMonth() !== prev.getUTCMonth() || cur.getUTCFullYear() !== prev.getUTCFullYear();
}

function isoWeek(d: Date): string {
  // YYYY-WW
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
    const shorts = longShort ? entries.slice(-topN).map((e) => e.symbol) : [];
    return { longs, shorts };
  }
  // 不限 topN → 全员等权（但 longShort 时按 score 正负切）
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
  initialCapital: number
): BacktestMetrics {
  if (equityCurve.length < 2) {
    return {
      totalReturn: 0,
      annualReturn: 0,
      annualVol: 0,
      sharpe: 0,
      maxDrawdown: 0,
      winRate: 0,
      tradeCount: trades.length,
      turnover: 0,
    };
  }
  const finalEq = equityCurve[equityCurve.length - 1]!.equity;
  const totalReturn = finalEq / initialCapital - 1;
  // 日收益
  const rets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const a = equityCurve[i - 1]!.equity;
    const b = equityCurve[i]!.equity;
    if (a > 0) rets.push(b / a - 1);
  }
  const mean = rets.reduce((s, x) => s + x, 0) / Math.max(1, rets.length);
  let varAcc = 0;
  for (const r of rets) varAcc += (r - mean) ** 2;
  const std = Math.sqrt(varAcc / Math.max(1, rets.length - 1));
  const annualReturn = mean * 252;
  const annualVol = std * Math.sqrt(252);
  const sharpe = annualVol > 1e-9 ? annualReturn / annualVol : 0;

  let peak = equityCurve[0]!.equity;
  let maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }
  const wins = rets.filter((r) => r > 0).length;
  const winRate = rets.length ? wins / rets.length : 0;

  // turnover = Σ|notional| / (avg equity) / years
  let traded = 0;
  for (const t of trades) traded += t.qty * t.price;
  const avgEquity = equityCurve.reduce((s, p) => s + p.equity, 0) / equityCurve.length;
  const years = Math.max(1 / 252, equityCurve.length / 252);
  const turnover = avgEquity > 0 ? traded / avgEquity / years : 0;

  return {
    totalReturn,
    annualReturn,
    annualVol,
    sharpe,
    maxDrawdown: maxDd,
    winRate,
    tradeCount: trades.length,
    turnover,
  };
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
  } = input;

  const equityCurve: BacktestEquityPoint[] = [];
  const trades: BacktestTrade[] = [];
  let cash = capital;
  const positions = new Map<string, Position>();
  let targets: { longs: string[]; shorts: string[] } = { longs: [], shorts: [] };
  let prevRebalanceDate: string | null = null;
  let skippedDays = 0;

  const commissionRate = costs.commissionBps / 10_000;
  const slipRate = costs.slippageBps / 10_000;

  const benchMap = new Map<string, number>();
  if (benchmarkSeries) {
    for (const p of benchmarkSeries) benchMap.set(p.date, p.close);
  }
  let benchBase: number | null = null;

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di]!;
    const barsToday = bars.get(date);
    if (!barsToday) continue;

    // 1) 先按 yesterday 的 targets 在 today open 撮合：换仓
    //    触发条件：再平衡日 OR 首次入场（positions 仍空但已有 targets）
    const isFirstEntry = positions.size === 0;
    if (
      di > 0 &&
      (isFirstEntry || isRebalanceDay(dates[di - 1]!, prevRebalanceDate, rebalance)) &&
      (targets.longs.length > 0 || targets.shorts.length > 0)
    ) {
      // 计算当前组合市值（用今日 open）
      let equityAtOpen = cash;
      for (const pos of positions.values()) {
        const px = barsToday.get(pos.symbol)?.open ?? null;
        if (px != null) equityAtOpen += pos.qty * px;
      }
      const allTargets = new Set([...targets.longs, ...targets.shorts]);
      const longCount = targets.longs.length;
      const shortCount = targets.shorts.length;
      const totalSlots = longCount + shortCount;
      // 单标的目标市值
      const perSlot = totalSlots > 0 ? equityAtOpen / totalSlots : 0;

      // 平仓非目标
      for (const [sym, pos] of positions) {
        if (allTargets.has(sym)) continue;
        const fillPx = barsToday.get(sym)?.open;
        if (fillPx == null) continue;
        const sellPx = fillPx * (1 - slipRate);
        const notional = pos.qty * sellPx;
        const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
        cash += notional - fee;
        trades.push({
          date,
          symbol: sym,
          side: "sell",
          qty: pos.qty,
          price: sellPx,
          commission: fee,
        });
        positions.delete(sym);
      }

      // 调仓到目标（先处理 longs，再处理 shorts）
      for (const sym of targets.longs) {
        const px = barsToday.get(sym)?.open;
        if (px == null) continue;
        const targetMV = perSlot;
        const cur = positions.get(sym);
        const curMV = cur ? cur.qty * px : 0;
        const delta = targetMV - curMV;
        if (Math.abs(delta) < equityAtOpen * 0.001) continue; // 阈值过滤
        const side = delta > 0 ? "buy" : "sell";
        const fillPx = side === "buy" ? px * (1 + slipRate) : px * (1 - slipRate);

        if (side === "buy") {
          // 预算：用可用现金的最大 notional，使得 notional*(1+commissionRate) ≤ cash
          // 且不超过目标增量
          const budget = Math.min(Math.abs(delta), Math.max(0, cash / (1 + commissionRate)));
          if (budget <= 0) continue;
          const qty = budget / fillPx;
          if (qty < 1e-9) continue;
          const notional = qty * fillPx;
          const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
          cash -= notional + fee;
          const newQty = (cur?.qty ?? 0) + qty;
          const newAvg = newQty > 0
            ? ((cur?.qty ?? 0) * (cur?.avgPrice ?? 0) + qty * fillPx) / newQty
            : 0;
          positions.set(sym, { symbol: sym, qty: newQty, avgPrice: newAvg });
          trades.push({ date, symbol: sym, side: "buy", qty, price: fillPx, commission: fee });
        } else {
          const qty = Math.abs(delta) / fillPx;
          if (qty < 1e-9) continue;
          const notional = qty * fillPx;
          const fee = Math.max(notional * commissionRate, costs.minCommission ?? 0);
          cash += notional - fee;
          const remaining = (cur?.qty ?? 0) - qty;
          if (remaining > 1e-9) {
            positions.set(sym, {
              symbol: sym,
              qty: remaining,
              avgPrice: cur?.avgPrice ?? fillPx,
            });
          } else {
            positions.delete(sym);
          }
          trades.push({ date, symbol: sym, side: "sell", qty, price: fillPx, commission: fee });
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
      } else {
        targets = picks;
      }
    } else {
      skippedDays++;
    }

    // 3) 用当日 close 估值 → equity 曲线
    let mtmEquity = cash;
    for (const pos of positions.values()) {
      const px = barsToday.get(pos.symbol)?.close ?? pos.avgPrice;
      mtmEquity += pos.qty * px;
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

  const metrics = computeMetrics(equityCurve, trades, capital);
  return {
    equityCurve,
    trades,
    metrics,
    meta: {
      latencyMs: Date.now() - t0,
      sampleSize: equityCurve.length,
      barCount: Array.from(bars.values()).reduce((s, m) => s + m.size, 0),
      skippedDays,
    },
  };
}
