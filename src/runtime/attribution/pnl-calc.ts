/**
 * Self-Evolving Agent P4b — PnL 计算纯函数层。
 *
 * 设计原则（在 fill 序列上跑 FIFO position book，逐日产 snapshot）：
 *
 *   - **纯函数**：零 DB / 零 IO / 零随机；输入完全决定输出。DB 层在 PnlAttributor 注入。
 *   - **跨日补齐**：from/to 范围内，即使某日无 fill，只要有持仓，也产 snapshot
 *     （unrealized 会随 mark 波动）；这是飞轮的核心要求。
 *   - **mark price fallback**：当日 mark 缺 → 用前一日 mark → 还缺 → 用 avgCost
 *     （unrealized=0；metadata.markSource='fallback_avg_cost' 标记）。
 *   - **手续费独立**：fill.fee 已知（broker 回报）则用之；否则调 `feeProvider` 估算
 *     （PnlAttributor 注入 FeeCalculator）。这样回测 / paper 也能有合理 fee。
 *   - **持仓口径**：v0 简化处理跨 0 反向：sell 量超过 qty 时，超出部分作为新空头建仓，
 *     avgCost = fill.price；不做对冲拆分。这与多数 broker 的 "净持仓" 视图一致。
 *   - **realized 当日口径**：按 fill 发生的本地 trading_day 累加；不重新分布到平均化日。
 *   - **incremental**：接受 priorPositions（从上一日的 snapshot 派生），让 PnlAttributor
 *     可以"从上次 done 的 day 继续算"，避免每次全量回扫历史 fill。
 *
 * 已覆盖边界（详见 __tests__/pnl-calc.test.ts）：
 *   - 单 symbol 单日单 fill；多日持仓 mark 波动；
 *   - 跨日多 fill 同 symbol；多 symbol；
 *   - 部分平仓；
 *   - 跨 0 反向（多→空 / 空→多）；
 *   - mark 缺失三级 fallback；
 *   - 增量从 priorPositions 起算；
 *   - 空 fills 但有 priorPositions（持仓估值漂移）；
 *   - 大量 fills 在同一 trading_day（聚合到一行 snapshot）。
 */

import { listTradingDaysByIso } from "./time-util";

/** 单次成交。来自 DB.fill；side 已规范化为 'buy'|'sell'。 */
export interface PnlFill {
  /** fill 的稳定 id；用于排序兜底 */
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  /** broker 已知 fee；未知则传 undefined，触发 feeProvider 估算 */
  fee?: number;
  /** market 本地 trading_day 'YYYY-MM-DD' */
  tradingDay: string;
  /** ISO timestamp；同日多个 fill 按此排序 */
  ts: string;
  /** 估 fee 时传给 feeProvider 的多维 key */
  market: string;
  assetClass?: string;
  broker?: string;
}

/** 单 symbol 持仓状态。qty 正为多头，负为空头，0 为平仓。 */
export interface PositionState {
  symbol: string;
  qty: number;
  avgCost: number;
  realizedCum: number;
  feeCum: number;
}

/** 单日 mark 字典：{symbol → {close, source}} */
export type MarkPriceLookup = (
  symbol: string,
  tradingDay: string
) => { close: number; source: string } | undefined;

/** 估 fee 的注入函数（PnlAttributor 注入 FeeCalculator）。返回 undefined 表示无法估 → 当 0。 */
export type FeeProvider = (fill: PnlFill) => number | undefined;

/** 计算输入。 */
export interface PnlCalcInput {
  /** 已按 (tradingDay asc, ts asc, id asc) 排序的 fill 序列 */
  fills: PnlFill[];
  /** 计算范围（含 fromDay，含 toDay） */
  fromDay: string;
  toDay: string;
  /** market scope；决定 listTradingDays 用哪个交易日历 */
  market: string;
  /** 上一日收盘后的持仓快照；增量计算用，全量首次跑可传 [] */
  priorPositions: PositionState[];
  /** mark 查询；缺当日 / fallback 由 caller 实现 */
  markLookup: MarkPriceLookup;
  /** fee 估算注入 */
  feeProvider?: FeeProvider;
}

/** 单日单 symbol 的 PnL 快照。一行 = strategy_pnl_snapshot 一行。 */
export interface PnlSnapshot {
  tradingDay: string;
  symbol: string;
  qty: number;
  avgCost: number | null;
  markPrice: number | null;
  marketValue: number;
  realizedPnlDaily: number;
  unrealizedPnlDaily: number;
  realizedPnlCum: number;
  unrealizedPnlCum: number;
  feeDaily: number;
  feeCum: number;
  turnoverDaily: number;
  /** 'eastmoney' / 'yfinance' / 'fallback_prev_day' / 'fallback_avg_cost' / 'no_mark' */
  markSource: string;
  /** 该日发生的 fill 数 */
  fillCount: number;
}

export interface PnlCalcResult {
  snapshots: PnlSnapshot[];
  /** 计算完成后的最终持仓，给下一次增量计算用 */
  finalPositions: PositionState[];
}

// ───────────────────────── 核心算法 ─────────────────────────

/**
 * 在 [fromDay, toDay] 范围内逐日计算 PnL。
 * 即使某日无 fill，只要有持仓，也产 snapshot；空仓且无 fill 的日子跳过。
 */
export function calcPnlSeries(input: PnlCalcInput): PnlCalcResult {
  const { fills, fromDay, toDay, market, priorPositions, markLookup, feeProvider } = input;

  // 1) 从 priorPositions 初始化 book
  const book = new Map<string, PositionState>();
  for (const p of priorPositions) {
    book.set(p.symbol, { ...p });
  }

  // 2) 把 fills 按 trading_day 分组
  const fillsByDay = new Map<string, PnlFill[]>();
  for (const f of fills) {
    if (f.tradingDay < fromDay || f.tradingDay > toDay) continue;
    if (!fillsByDay.has(f.tradingDay)) fillsByDay.set(f.tradingDay, []);
    fillsByDay.get(f.tradingDay)?.push(f);
  }

  // 3) 逐日推进
  const tradingDays = listTradingDaysByIso(fromDay, toDay, market);
  const snapshots: PnlSnapshot[] = [];

  // 跟踪每个 symbol 上一日的 mark，用于跨日 unrealized_daily 差值
  const prevDayMark = new Map<string, { close: number; source: string }>();
  // 记录 mark fallback 链上的"上一日"，给 fallback_prev_day 使用
  const lastKnownMark = new Map<string, { day: string; close: number; source: string }>();

  for (const day of tradingDays) {
    const dayFills = (fillsByDay.get(day) ?? []).slice().sort(compareFills);
    const allSymbols = collectActiveSymbols(book, dayFills);

    // 单日内累加 realized/fee/turnover by symbol
    const dailyAcc = new Map<
      string,
      { realized: number; fee: number; turnover: number; fillCount: number }
    >();
    for (const sym of allSymbols) {
      dailyAcc.set(sym, { realized: 0, fee: 0, turnover: 0, fillCount: 0 });
    }

    for (const f of dayFills) {
      const acc = dailyAcc.get(f.symbol);
      if (!acc) continue;
      const fee = f.fee ?? feeProvider?.(f) ?? 0;
      const { realizedDelta, turnover } = applyFill(book, f);
      acc.realized += realizedDelta;
      acc.fee += fee;
      acc.turnover += turnover;
      acc.fillCount += 1;
      // fee 累积入 book.feeCum 单独跟（不进 realized）
      const pos = book.get(f.symbol);
      if (pos) pos.feeCum += fee;
    }

    // 每个 symbol 产 snapshot；空仓 + 当日无 fill 则跳过
    for (const sym of allSymbols) {
      const pos = book.get(sym) ?? {
        symbol: sym,
        qty: 0,
        avgCost: 0,
        realizedCum: 0,
        feeCum: 0,
      };
      const acc = dailyAcc.get(sym) ?? { realized: 0, fee: 0, turnover: 0, fillCount: 0 };

      // 空仓且当日无 fill 也无 prior → 跳过（毫无信息量的 zero row）
      if (pos.qty === 0 && acc.fillCount === 0 && !prevDayMark.has(sym)) continue;

      const markInfo = resolveMark(sym, day, markLookup, lastKnownMark, pos.avgCost);
      const markPrice = markInfo.price;
      const markSource = markInfo.source;

      const marketValue = pos.qty * (markPrice ?? 0);
      // realized 已累加到 pos.realizedCum；当日值 = acc.realized
      const realizedDaily = acc.realized;
      pos.realizedCum += realizedDaily;

      // unrealized 用"今日 mark vs avgCost"
      const unrealizedCum = pos.qty !== 0 && markPrice !== null
        ? pos.qty * (markPrice - pos.avgCost)
        : 0;

      // unrealizedDaily：和上一日 unrealizedCum 的差值
      // 上一日 unrealizedCum 我们要从前一 snapshot 反推，这里用 prevDayMark 简化重建
      const prevMarkRec = prevDayMark.get(sym);
      let unrealizedDaily = 0;
      if (prevMarkRec && markPrice !== null) {
        // 用今天的 mark - 昨天的 mark 乘以 today_qty（保守：忽略当日交易引起的 size 变化）
        // 严格做法应在 fill 应用前后用 (markToday - markPrev) * priorQty + (markToday - fillPrice) * fillDeltaQty
        // 但 v0 简化为：unrealizedDaily = unrealizedCum_today - unrealizedCum_prev
        const prevUnrealizedCum = pos.qty * (prevMarkRec.close - pos.avgCost);
        unrealizedDaily = unrealizedCum - prevUnrealizedCum;
      } else if (markPrice !== null && pos.qty !== 0) {
        // 第一天就拿到 mark：unrealizedDaily 等于全量 unrealizedCum
        unrealizedDaily = unrealizedCum;
      }

      snapshots.push({
        tradingDay: day,
        symbol: sym,
        qty: pos.qty,
        avgCost: pos.qty === 0 ? null : pos.avgCost,
        markPrice,
        marketValue,
        realizedPnlDaily: round6(realizedDaily),
        unrealizedPnlDaily: round6(unrealizedDaily),
        realizedPnlCum: round6(pos.realizedCum),
        unrealizedPnlCum: round6(unrealizedCum),
        feeDaily: round6(acc.fee),
        feeCum: round6(pos.feeCum),
        turnoverDaily: round6(acc.turnover),
        markSource,
        fillCount: acc.fillCount,
      });

      if (markPrice !== null && markSource !== "fallback_avg_cost" && markSource !== "no_mark") {
        prevDayMark.set(sym, { close: markPrice, source: markSource });
      }
    }
  }

  return {
    snapshots,
    finalPositions: Array.from(book.values()),
  };
}

// ───────────────────────── helpers ─────────────────────────

function compareFills(a: PnlFill, b: PnlFill): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

function collectActiveSymbols(
  book: Map<string, PositionState>,
  dayFills: PnlFill[]
): Set<string> {
  const out = new Set<string>(book.keys());
  for (const f of dayFills) out.add(f.symbol);
  return out;
}

/**
 * 把 fill 应用到 book，返回 realizedDelta 与 turnover（abs(qty*price)）。
 * 跨 0 反向：超额部分作为新建反向仓，avgCost = fill.price。
 */
function applyFill(
  book: Map<string, PositionState>,
  f: PnlFill
): { realizedDelta: number; turnover: number } {
  let pos = book.get(f.symbol);
  if (!pos) {
    pos = { symbol: f.symbol, qty: 0, avgCost: 0, realizedCum: 0, feeCum: 0 };
    book.set(f.symbol, pos);
  }
  const turnover = Math.abs(f.qty * f.price);

  // 同向加仓（多头买 / 空头卖）→ 加权平均成本
  const isLong = pos.qty > 0;
  const isShort = pos.qty < 0;
  const flat = pos.qty === 0;

  if (f.side === "buy") {
    if (flat || isLong) {
      // 多头加仓
      const totalCost = pos.qty * pos.avgCost + f.qty * f.price;
      const totalQty = pos.qty + f.qty;
      pos.avgCost = totalQty === 0 ? 0 : totalCost / totalQty;
      pos.qty = totalQty;
      return { realizedDelta: 0, turnover };
    }
    // 空头买回（减仓 / 平仓 / 反向开多）
    const coverQty = Math.min(-pos.qty, f.qty);
    const realized = (pos.avgCost - f.price) * coverQty; // 空头：成本 - 价格
    pos.qty += coverQty; // 空头 qty 负数 → 加正 = 向 0 靠近
    if (pos.qty === 0) pos.avgCost = 0;
    const remainder = f.qty - coverQty;
    if (remainder > 0) {
      // 反向开多
      pos.qty = remainder;
      pos.avgCost = f.price;
    }
    return { realizedDelta: realized, turnover };
  }

  // sell
  if (flat || isShort) {
    // 空头加仓：qty 负向 + sell qty 负向
    const totalCost = Math.abs(pos.qty) * pos.avgCost + f.qty * f.price;
    const totalQty = Math.abs(pos.qty) + f.qty;
    pos.avgCost = totalQty === 0 ? 0 : totalCost / totalQty;
    pos.qty = -totalQty;
    return { realizedDelta: 0, turnover };
  }
  // 多头卖出（减仓 / 平仓 / 反向开空）
  const closeQty = Math.min(pos.qty, f.qty);
  const realized = (f.price - pos.avgCost) * closeQty;
  pos.qty -= closeQty;
  if (pos.qty === 0) pos.avgCost = 0;
  const remainder = f.qty - closeQty;
  if (remainder > 0) {
    pos.qty = -remainder;
    pos.avgCost = f.price;
  }
  return { realizedDelta: realized, turnover };
}

/** mark 三级 fallback：当日 → 上一日已知 → avgCost（unrealized=0）→ 没仓位则 null */
function resolveMark(
  symbol: string,
  day: string,
  markLookup: MarkPriceLookup,
  lastKnown: Map<string, { day: string; close: number; source: string }>,
  avgCost: number
): { price: number | null; source: string } {
  const today = markLookup(symbol, day);
  if (today) {
    lastKnown.set(symbol, { day, close: today.close, source: today.source });
    return { price: today.close, source: today.source };
  }
  const prev = lastKnown.get(symbol);
  if (prev && prev.day < day) {
    return { price: prev.close, source: "fallback_prev_day" };
  }
  if (avgCost > 0) {
    return { price: avgCost, source: "fallback_avg_cost" };
  }
  return { price: null, source: "no_mark" };
}

/** 4 位小数舍入，避免浮点累积误差暴露给 reader。 */
function round6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}
