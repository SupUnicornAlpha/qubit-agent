import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { indicatorStrategyScript, strategyRuntime } from "../../db/sqlite/schema";
import { processExecutionTasks } from "../execution/execution-worker";
import { computeDateRangeForLimit, queryBarsRange } from "../market/klines-query";
import { isWithinTradingSession } from "../market/trading-calendar";
import { evaluateSignalCode } from "./signal-evaluator";
import { appendStrategyRuntimeLog } from "./strategy-runtime-log";
import {
  recordSignalDedup,
  submitRuntimeOrder,
  type StrategyRuntimeParams,
} from "./strategy-runtime-service";

const DEFAULT_TICK_MS = 30_000;

function parseParams(raw: unknown): StrategyRuntimeParams {
  if (!raw || typeof raw !== "object") return {};
  return raw as StrategyRuntimeParams;
}

async function tickOneRuntime(
  runtime: typeof strategyRuntime.$inferSelect,
  now: Date
): Promise<void> {
  const db = await getDb();
  const params = parseParams(runtime.paramsJson);

  if (
    !isWithinTradingSession(now, runtime.market, {
      tradingDays: params.tradingDays,
      tradingStart: params.tradingStart,
      tradingEnd: params.tradingEnd,
      timezone: params.timezone,
    })
  ) {
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

  let bars;
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

  const lastBar = bars[bars.length - 1]!;
  const evalMode =
    params.strategyMode === "script" || (script.signalCode.includes("def on_bar") && !script.signalCode.includes("buy"))
      ? "script"
      : "indicator";
  const signal = await evaluateSignalCode(script.signalCode, bars, evalMode);

  if (signal.error) {
    await appendStrategyRuntimeLog(db, {
      strategyRuntimeId: runtime.id,
      level: "error",
      message: "signal_eval_error",
      payload: { error: signal.error },
    });
    return;
  }

  const barTime = signal.barTime ?? lastBar.time;
  await db
    .update(strategyRuntime)
    .set({
      lastBarTime: barTime,
      updatedAt: now.toISOString(),
    })
    .where(eq(strategyRuntime.id, runtime.id));

  const orderQty = params.orderQty ?? 100;
  const price = lastBar.close;

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
    const ms = Number(process.env["QUBIT_STRATEGY_RUNTIME_TICK_MS"] ?? DEFAULT_TICK_MS);
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
