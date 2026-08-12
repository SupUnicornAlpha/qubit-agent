import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  indicatorStrategyScript,
  strategyPositionSnapshot,
  strategyRuntime,
} from "../../db/sqlite/schema";
import { processExecutionTasks } from "../execution/execution-worker";
import { computeDateRangeForLimit, queryBarsRange } from "../market/klines-query";
import { isWithinTradingSession } from "../market/trading-calendar";
import { evaluateSignalCode } from "./signal-evaluator";
import { appendStrategyRuntimeLog } from "./strategy-runtime-log";
import {
  type StrategyRuntimeParams,
  recordSignalDedup,
  submitRuntimeOrder,
} from "./strategy-runtime-service";

const DEFAULT_TICK_MS = 30_000;

function parseParams(raw: unknown): StrategyRuntimeParams {
  if (!raw || typeof raw !== "object") return {};
  return raw as StrategyRuntimeParams;
}

function isStrategyApiV2Script(script: typeof indicatorStrategyScript.$inferSelect): boolean {
  try {
    const snapshot = JSON.parse(String(script.chartSnapshotJson ?? "{}")) as {
      strategyApiV2?: boolean;
    };
    return snapshot.strategyApiV2 === true;
  } catch {
    return false;
  }
}

function wholeShareQty(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Convert the latest Strategy API V2 target instruction into a desired long
 * position. Contract backtests intentionally leave the final bar pending (to
 * model next-open fills); the persistent runtime consumes that pending target
 * on the next eligible simulation tick instead.
 */
async function resolveContractTargetQty(input: {
  strategyCode: string;
  bars: Awaited<ReturnType<typeof queryBarsRange>>;
  symbol: string;
  price: number;
  paperCapital: number;
  currentQty: number;
  params: Record<string, unknown>;
}): Promise<{ targetQty: number; reason: string } | { error: string }> {
  const { backtestStrategyContract } = await import("./v2/contract-service");
  const result = await backtestStrategyContract({
    strategyCode: input.strategyCode,
    bars: input.bars,
    symbol: input.symbol,
    initialCapital: input.paperCapital,
    params: input.params,
  });
  if (!result.ok) return { error: result.error };

  const pending = (result.pendingIntents ?? []).filter((intent) => {
    const symbol = String(intent.symbol ?? "")
      .trim()
      .toUpperCase();
    return (
      !symbol ||
      symbol === input.symbol.trim().toUpperCase() ||
      symbol.endsWith(`:${input.symbol.trim().toUpperCase()}`)
    );
  });
  const latest = pending[pending.length - 1];
  if (!latest) return { targetQty: input.currentQty, reason: "no_latest_contract_intent" };

  const kind = String(latest.kind ?? "").trim();
  const value = Number(latest.value);
  if (!Number.isFinite(value)) return { error: "invalid_contract_intent_value" };
  const price = input.price;
  let targetQty: number;
  switch (kind) {
    case "target_percent":
      targetQty = (input.paperCapital * value) / price;
      break;
    case "target_quantity":
      targetQty = value;
      break;
    case "target_value":
      targetQty = value / price;
      break;
    case "quantity":
      targetQty = input.currentQty + value;
      break;
    case "value":
      targetQty = input.currentQty + value / price;
      break;
    default:
      return { error: `unsupported_contract_intent_kind:${kind || "unknown"}` };
  }
  return {
    targetQty: wholeShareQty(Math.max(0, targetQty)),
    reason: String(latest.reason ?? ""),
  };
}

async function tickOneRuntime(
  runtime: typeof strategyRuntime.$inferSelect,
  now: Date
): Promise<void> {
  const db = await getDb();
  const params = parseParams(runtime.paramsJson);

  const sessionOverrides = {
    ...(params.tradingDays !== undefined ? { tradingDays: params.tradingDays } : {}),
    ...(params.tradingStart !== undefined ? { tradingStart: params.tradingStart } : {}),
    ...(params.tradingEnd !== undefined ? { tradingEnd: params.tradingEnd } : {}),
    ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
  };
  if (!isWithinTradingSession(now, runtime.market, sessionOverrides)) {
    return;
  }

  const scripts = await db
    .select()
    .from(indicatorStrategyScript)
    .where(eq(indicatorStrategyScript.id, runtime.strategyScriptId))
    .limit(1);
  const script = scripts[0];
  if (!script?.signalCode?.trim()) {
    await appendStrategyRuntimeLog(db, {
      strategyRuntimeId: runtime.id,
      level: "warn",
      message: "empty_signal_code",
    });
    return;
  }

  const barLimit = Math.max(20, Math.min(params.barLimit ?? 120, 500));
  const { startDate, endDate, period } = computeDateRangeForLimit(runtime.timeframe, barLimit);

  let bars: Awaited<ReturnType<typeof queryBarsRange>>;
  try {
    bars = await queryBarsRange({
      symbol: runtime.symbol,
      exchange: runtime.market,
      period,
      startDate,
      endDate,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db
      .update(strategyRuntime)
      .set({ status: "error", errorMessage: msg, updatedAt: now.toISOString() })
      .where(eq(strategyRuntime.id, runtime.id));
    await appendStrategyRuntimeLog(db, {
      strategyRuntimeId: runtime.id,
      level: "error",
      message: "klines_fetch_failed",
      payload: { error: msg },
    });
    return;
  }

  if (!bars.length) return;

  const lastBar = bars.at(-1);
  if (!lastBar) return;
  // A worker tick may run every few seconds while the newest closed bar remains
  // unchanged.  Evaluate each bar once; otherwise an invalid expression floods
  // the trace and a healthy strategy wastes cycles re-evaluating the same input.
  if (runtime.lastBarTime === lastBar.timestamp) return;

  const markBarEvaluated = async () => {
    await db
      .update(strategyRuntime)
      .set({ lastBarTime: lastBar.timestamp, updatedAt: now.toISOString() })
      .where(eq(strategyRuntime.id, runtime.id));
  };
  const contractMode = params.strategyMode === "contract" || isStrategyApiV2Script(script);
  if (contractMode) {
    const existing = await db
      .select()
      .from(strategyPositionSnapshot)
      .where(
        and(
          eq(strategyPositionSnapshot.strategyRuntimeId, runtime.id),
          eq(strategyPositionSnapshot.symbol, runtime.symbol)
        )
      )
      .limit(1);
    const currentQty = existing[0]?.qty ?? 0;
    const capital = Number(params.paperCapital ?? 100_000);
    const target = await resolveContractTargetQty({
      strategyCode: script.signalCode,
      bars,
      symbol: runtime.symbol,
      price: lastBar.close,
      paperCapital: Number.isFinite(capital) && capital > 0 ? capital : 100_000,
      currentQty,
      params: params as Record<string, unknown>,
    });
    if ("error" in target) {
      await markBarEvaluated();
      await appendStrategyRuntimeLog(db, {
        strategyRuntimeId: runtime.id,
        level: "error",
        message: "contract_signal_eval_error",
        payload: {
          error: target.error,
          symbol: runtime.symbol,
          timeframe: runtime.timeframe,
          barTime: lastBar.timestamp,
          price: lastBar.close,
          currentQty,
        },
      });
      return;
    }

    const barTime = lastBar.timestamp;
    await markBarEvaluated();
    const delta = target.targetQty - currentQty;
    await appendStrategyRuntimeLog(db, {
      strategyRuntimeId: runtime.id,
      level: "info",
      message: "contract_signal_evaluated",
      payload: {
        symbol: runtime.symbol,
        timeframe: runtime.timeframe,
        barTime,
        price: lastBar.close,
        currentQty,
        targetQty: target.targetQty,
        delta,
        reason: target.reason,
        action: delta > 0 ? "buy" : delta < 0 ? "sell" : "hold",
      },
    });
    if (!delta) return;
    const side = delta > 0 ? "buy" : "sell";
    const fresh = await recordSignalDedup(db, {
      strategyRuntimeId: runtime.id,
      symbol: runtime.symbol,
      signalType: side,
      signalBarTime: barTime,
    });
    if (!fresh) return;
    try {
      const { orderIntentId } = await submitRuntimeOrder(db, runtime, {
        side,
        qty: Math.abs(delta),
        price: lastBar.close,
        signalBarTime: barTime,
      });
      await db
        .update(strategyRuntime)
        .set({ lastSignalAt: now.toISOString(), updatedAt: now.toISOString() })
        .where(eq(strategyRuntime.id, runtime.id));
      await appendStrategyRuntimeLog(db, {
        strategyRuntimeId: runtime.id,
        level: "info",
        message: "contract_target_executed",
        payload: {
          orderIntentId,
          barTime,
          price: lastBar.close,
          currentQty,
          targetQty: target.targetQty,
          reason: target.reason,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendStrategyRuntimeLog(db, {
        strategyRuntimeId: runtime.id,
        level: "error",
        message: "contract_order_failed",
        payload: { error: msg, targetQty: target.targetQty },
      });
    }
    return;
  }
  const evalMode =
    params.strategyMode === "script" ||
    (script.signalCode.includes("def on_bar") && !script.signalCode.includes("buy"))
      ? "script"
      : "indicator";
  const signal = await evaluateSignalCode(script.signalCode, bars, evalMode);

  if (signal.error) {
    await markBarEvaluated();
    await appendStrategyRuntimeLog(db, {
      strategyRuntimeId: runtime.id,
      level: "error",
      message: "signal_eval_error",
      payload: {
        error: signal.error,
        symbol: runtime.symbol,
        timeframe: runtime.timeframe,
        barTime: lastBar.timestamp,
        price: lastBar.close,
      },
    });
    return;
  }

  const barTime = signal.barTime ?? lastBar.timestamp;
  await markBarEvaluated();

  const orderQty = params.orderQty ?? 100;
  const price = lastBar.close;

  await appendStrategyRuntimeLog(db, {
    strategyRuntimeId: runtime.id,
    level: "info",
    message: "signal_evaluated",
    payload: {
      symbol: runtime.symbol,
      timeframe: runtime.timeframe,
      barTime,
      price,
      buy: signal.buy,
      sell: signal.sell,
      action: signal.buy ? "buy" : signal.sell ? "sell" : "hold",
    },
  });

  if (signal.buy) {
    const fresh = await recordSignalDedup(db, {
      strategyRuntimeId: runtime.id,
      symbol: runtime.symbol,
      signalType: "buy",
      signalBarTime: barTime,
    });
    if (!fresh) return;

    try {
      const { orderIntentId } = await submitRuntimeOrder(db, runtime, {
        side: "buy",
        qty: orderQty,
        price,
        signalBarTime: barTime,
      });
      await db
        .update(strategyRuntime)
        .set({ lastSignalAt: now.toISOString(), updatedAt: now.toISOString() })
        .where(eq(strategyRuntime.id, runtime.id));
      await appendStrategyRuntimeLog(db, {
        strategyRuntimeId: runtime.id,
        level: "info",
        message: "buy_signal_executed",
        payload: { orderIntentId, barTime, price },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendStrategyRuntimeLog(db, {
        strategyRuntimeId: runtime.id,
        level: "error",
        message: "buy_order_failed",
        payload: { error: msg },
      });
    }
  }

  if (signal.sell) {
    const fresh = await recordSignalDedup(db, {
      strategyRuntimeId: runtime.id,
      symbol: runtime.symbol,
      signalType: "sell",
      signalBarTime: barTime,
    });
    if (!fresh) return;

    try {
      const { orderIntentId } = await submitRuntimeOrder(db, runtime, {
        side: "sell",
        qty: orderQty,
        price,
        signalBarTime: barTime,
      });
      await db
        .update(strategyRuntime)
        .set({ lastSignalAt: now.toISOString(), updatedAt: now.toISOString() })
        .where(eq(strategyRuntime.id, runtime.id));
      await appendStrategyRuntimeLog(db, {
        strategyRuntimeId: runtime.id,
        level: "info",
        message: "sell_signal_executed",
        payload: { orderIntentId, barTime, price },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendStrategyRuntimeLog(db, {
        strategyRuntimeId: runtime.id,
        level: "error",
        message: "sell_order_failed",
        payload: { error: msg },
      });
    }
  }
}

export async function processStrategyRuntimes(now = new Date()): Promise<void> {
  const db = await getDb();
  const runtimes = await db
    .select()
    .from(strategyRuntime)
    .where(eq(strategyRuntime.status, "running"));

  for (const runtime of runtimes) {
    try {
      await tickOneRuntime(runtime, now);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendStrategyRuntimeLog(db, {
        strategyRuntimeId: runtime.id,
        level: "error",
        message: "runtime_tick_failed",
        payload: { error: msg },
      });
    }
  }

  await processExecutionTasks(db, now);
}

/**
 * Event-driven path: closed bar / news-related symbol → tick matching runtimes only.
 * Prefer this over the 30s poll for sim/realtime (lower latency, no LLM).
 */
export async function processStrategyRuntimesForSymbol(
  symbol: string,
  now = new Date()
): Promise<{ matched: number }> {
  const db = await getDb();
  const sym = symbol.trim().toUpperCase();
  const runtimes = await db
    .select()
    .from(strategyRuntime)
    .where(eq(strategyRuntime.status, "running"));
  const matched = runtimes.filter(
    (r) => r.symbol.trim().toUpperCase() === sym || r.symbol.trim().toUpperCase().includes(sym)
  );
  for (const runtime of matched) {
    try {
      await tickOneRuntime(runtime, now);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendStrategyRuntimeLog(db, {
        strategyRuntimeId: runtime.id,
        level: "error",
        message: "runtime_bar_tick_failed",
        payload: { error: msg, symbol: sym },
      });
    }
  }
  if (matched.length > 0) {
    await processExecutionTasks(db, now);
  }
  return { matched: matched.length };
}

export class StrategyRuntimeWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await processStrategyRuntimes(now);
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer) return;
    const ms = Number(process.env.QUBIT_STRATEGY_RUNTIME_TICK_MS ?? DEFAULT_TICK_MS);
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export const strategyRuntimeWorker = new StrategyRuntimeWorker();
