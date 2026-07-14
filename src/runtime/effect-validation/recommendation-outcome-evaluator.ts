import { and, asc, eq, inArray } from "drizzle-orm";
import type { BarData } from "../../connectors/data/data.connector";
import { getDb } from "../../db/sqlite/client";
import { recommendationOutcome, recommendationSnapshot } from "../../db/sqlite/schema";
import { queryBarsRange } from "../market/klines-query";
import { type RecommendationSide, recommendationService } from "./recommendation-service";

export const RECOMMENDATION_ENGINE_VERSION = "decision-signal-v1";
export const DEFAULT_RECOMMENDATION_HORIZONS = [1, 5, 20, 60] as const;

export interface DecisionSignalForEvaluation {
  id: string;
  symbol: string;
  market: string;
  side: RecommendationSide;
  horizonDays: number;
  asof: string;
  entryLow: number | null;
  entryHigh: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  benchmarkSymbol: string | null;
  expiresAt: string | null;
}

export type EvaluationResult =
  | { kind: "not_ready"; barsObserved: number; reason: string }
  | { kind: "invalid"; barsObserved: number; reason: string }
  | {
      kind: "evaluated";
      barsObserved: number;
      startPrice: number;
      endPrice: number;
      entryPrice: number;
      entryAt: string;
      exitPrice: number;
      exitAt: string;
      exitReason: "horizon" | "stop_loss" | "take_profit";
      returnPct: number;
      maxFavorableExcursionPct: number;
      maxAdverseExcursionPct: number;
      stopLossTriggered: boolean;
      takeProfitTriggered: boolean;
      ambiguousBar: boolean;
      outcome: "win" | "loss" | "flat";
    };

export function evaluateDecisionSignal(
  signal: DecisionSignalForEvaluation,
  bars: BarData[],
  neutralBandPct = 0.5
): EvaluationResult {
  const asofMs = Date.parse(signal.asof);
  const eligible = bars
    .filter(
      (bar) => Number.isFinite(Date.parse(bar.timestamp)) && Date.parse(bar.timestamp) > asofMs
    )
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const horizon = Math.max(1, Math.floor(signal.horizonDays));
  if (eligible.length < horizon + 1) {
    return {
      kind: "not_ready",
      barsObserved: eligible.length,
      reason: "insufficient_forward_bars",
    };
  }

  const entryIndex = findEntryIndex(signal, eligible);
  if (entryIndex < 0) {
    return { kind: "invalid", barsObserved: eligible.length, reason: "entry_not_triggered" };
  }
  if (eligible.length <= entryIndex + horizon) {
    return {
      kind: "not_ready",
      barsObserved: eligible.length - entryIndex,
      reason: "insufficient_bars_after_entry",
    };
  }

  const entryBar = eligible[entryIndex];
  if (!entryBar) {
    return { kind: "invalid", barsObserved: eligible.length, reason: "entry_bar_missing" };
  }
  const entryPrice = resolveEntryPrice(signal, entryBar);
  const observed = eligible.slice(entryIndex, entryIndex + horizon + 1);
  const horizonBar = observed[observed.length - 1];
  const firstEligibleBar = eligible[0];
  if (!horizonBar || !firstEligibleBar) {
    return { kind: "not_ready", barsObserved: observed.length, reason: "horizon_bar_missing" };
  }
  let exitPrice = horizonBar.close;
  let exitAt = horizonBar.timestamp;
  let exitReason: "horizon" | "stop_loss" | "take_profit" = "horizon";
  let stopLossTriggered = false;
  let takeProfitTriggered = false;
  let ambiguousBar = false;
  let maxFavorableExcursionPct = 0;
  let maxAdverseExcursionPct = 0;

  for (const bar of observed) {
    const favorable = excursionPct(signal.side, entryPrice, bar.high, bar.low, true);
    const adverse = excursionPct(signal.side, entryPrice, bar.high, bar.low, false);
    maxFavorableExcursionPct = Math.max(maxFavorableExcursionPct, favorable);
    maxAdverseExcursionPct = Math.min(maxAdverseExcursionPct, adverse);

    const stopHit = hitStop(signal, bar);
    const targetHit = hitTarget(signal, bar);
    if (stopHit && targetHit) {
      ambiguousBar = true;
      stopLossTriggered = true;
      exitReason = "stop_loss";
      exitPrice = signal.stopLoss ?? bar.close;
      exitAt = bar.timestamp;
      break;
    }
    if (stopHit) {
      stopLossTriggered = true;
      exitReason = "stop_loss";
      exitPrice = signal.stopLoss ?? bar.close;
      exitAt = bar.timestamp;
      break;
    }
    if (targetHit) {
      takeProfitTriggered = true;
      exitReason = "take_profit";
      exitPrice = signal.takeProfit ?? bar.close;
      exitAt = bar.timestamp;
      break;
    }
  }

  const rawReturnPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  const returnPct =
    signal.side === "short" ? -rawReturnPct : signal.side === "neutral" ? 0 : rawReturnPct;
  const outcome =
    returnPct > neutralBandPct ? "win" : returnPct < -neutralBandPct ? "loss" : "flat";
  return {
    kind: "evaluated",
    barsObserved: observed.length,
    startPrice: firstEligibleBar.close,
    endPrice: horizonBar.close,
    entryPrice,
    entryAt: entryBar.timestamp,
    exitPrice,
    exitAt,
    exitReason,
    returnPct,
    maxFavorableExcursionPct,
    maxAdverseExcursionPct,
    stopLossTriggered,
    takeProfitTriggered,
    ambiguousBar,
    outcome,
  };
}

export async function evaluateRecommendationOutcomes(
  input: {
    projectId?: string;
    limit?: number;
    force?: boolean;
    now?: Date;
  } = {}
) {
  const db = await getDb();
  const conditions = [
    inArray(recommendationSnapshot.status, ["active", "closed", "expired"]),
    input.projectId ? eq(recommendationSnapshot.projectId, input.projectId) : undefined,
  ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
  const signals = await db
    .select()
    .from(recommendationSnapshot)
    .where(and(...conditions))
    .orderBy(asc(recommendationSnapshot.asof))
    .limit(Math.max(1, Math.min(input.limit ?? 50, 200)));

  const existing = signals.length
    ? await db
        .select()
        .from(recommendationOutcome)
        .where(
          inArray(
            recommendationOutcome.recommendationId,
            signals.map((signal) => signal.id)
          )
        )
    : [];
  const existingByKey = new Map(
    existing.map((row) => [`${row.recommendationId}:${row.horizonDays}`, row])
  );
  const now = input.now ?? new Date();
  const summary = { scanned: signals.length, evaluated: 0, notReady: 0, invalid: 0, failed: 0 };
  const benchmarkCache = new Map<string, BarData[]>();

  for (const signal of signals) {
    try {
      const bars = await queryBarsRange({
        symbol: signal.symbol,
        exchange: signal.market,
        period: "1d",
        startDate: signal.asof,
        endDate: now.toISOString(),
        workflowRunId: signal.workflowRunId,
      });
      const benchmarkBars = await loadBenchmarkBars(signal, now, benchmarkCache);
      for (const horizonDays of evaluationHorizons(signal.horizonDays)) {
        const previous = existingByKey.get(`${signal.id}:${horizonDays}`);
        if (!input.force && previous && previous.outcome !== "pending") continue;
        const result = evaluateDecisionSignal({ ...signal, horizonDays }, bars);
        if (result.kind === "not_ready") {
          summary.notReady += 1;
          await recommendationService.recordOutcome({
            recommendationId: signal.id,
            horizonDays,
            outcome: "pending",
            barsObserved: result.barsObserved,
            evaluationError: result.reason,
          });
          continue;
        }
        if (result.kind === "invalid") {
          summary.invalid += 1;
          await recommendationService.recordOutcome({
            recommendationId: signal.id,
            horizonDays,
            outcome: "invalid",
            barsObserved: result.barsObserved,
            evaluationError: result.reason,
            evaluatedAt: now.toISOString(),
          });
          continue;
        }
        summary.evaluated += 1;
        const benchmarkReturnPct = returnBetween(benchmarkBars, result.entryAt, result.exitAt);
        await recommendationService.recordOutcome({
          recommendationId: signal.id,
          horizonDays,
          ...result,
          benchmarkReturnPct,
          excessReturnPct:
            benchmarkReturnPct == null ? null : result.returnPct - benchmarkReturnPct,
          hit: result.outcome === "win",
          evaluatedAt: now.toISOString(),
          evaluationError: null,
        });
      }
      if (signal.status === "active" && signal.expiresAt && signal.expiresAt <= now.toISOString()) {
        await recommendationService.setStatus(signal.id, "expired");
      }
    } catch (error) {
      summary.failed += 1;
      for (const horizonDays of evaluationHorizons(signal.horizonDays)) {
        await recommendationService.recordOutcome({
          recommendationId: signal.id,
          horizonDays,
          outcome: "pending",
          evaluationError: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return summary;
}

function findEntryIndex(signal: DecisionSignalForEvaluation, bars: BarData[]): number {
  const first = signal.entryLow ?? signal.entryHigh;
  if (first == null) return 0;
  const second = signal.entryHigh ?? signal.entryLow ?? first;
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  return bars.findIndex((bar) => bar.high >= low && bar.low <= high);
}

function resolveEntryPrice(signal: DecisionSignalForEvaluation, bar: BarData): number {
  if (signal.entryLow == null && signal.entryHigh == null) return bar.close;
  const planned =
    signal.side === "short"
      ? (signal.entryLow ?? signal.entryHigh ?? bar.close)
      : (signal.entryHigh ?? signal.entryLow ?? bar.close);
  return Math.max(bar.low, Math.min(bar.high, planned));
}

function hitStop(signal: DecisionSignalForEvaluation, bar: BarData): boolean {
  if (signal.stopLoss == null || signal.side === "neutral") return false;
  return signal.side === "short" ? bar.high >= signal.stopLoss : bar.low <= signal.stopLoss;
}

function hitTarget(signal: DecisionSignalForEvaluation, bar: BarData): boolean {
  if (signal.takeProfit == null || signal.side === "neutral") return false;
  return signal.side === "short" ? bar.low <= signal.takeProfit : bar.high >= signal.takeProfit;
}

function excursionPct(
  side: RecommendationSide,
  entryPrice: number,
  high: number,
  low: number,
  favorable: boolean
): number {
  if (side === "neutral") return 0;
  const price = side === "short" ? (favorable ? low : high) : favorable ? high : low;
  const raw = ((price - entryPrice) / entryPrice) * 100;
  return side === "short" ? -raw : raw;
}

export class RecommendationOutcomeWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await evaluateRecommendationOutcomes();
      if (result.evaluated || result.invalid || result.failed) {
        console.log(`[recommendationOutcome] ${JSON.stringify(result)}`);
      }
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer || process.env.QUBIT_RECOMMENDATION_OUTCOME_ENABLED === "0") return;
    const tickMs = Math.max(
      60_000,
      Number(process.env.QUBIT_RECOMMENDATION_OUTCOME_TICK_MS ?? 6 * 60 * 60 * 1000)
    );
    this.startupTimer = setTimeout(() => void this.tick(), 60_000);
    this.timer = setInterval(() => void this.tick(), tickMs);
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }
}

export const recommendationOutcomeWorker = new RecommendationOutcomeWorker();

export function evaluationHorizons(primaryHorizonDays: number): number[] {
  return [...new Set([...DEFAULT_RECOMMENDATION_HORIZONS, Math.max(1, primaryHorizonDays)])].sort(
    (left, right) => left - right
  );
}

async function loadBenchmarkBars(
  signal: DecisionSignalForEvaluation,
  now: Date,
  cache: Map<string, BarData[]>
): Promise<BarData[]> {
  const benchmarkSymbol = signal.benchmarkSymbol || defaultBenchmarkForMarket(signal.market);
  if (!benchmarkSymbol) return [];
  const cacheKey = `${benchmarkSymbol}:${signal.market}:${signal.asof}:${now.toISOString()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  try {
    const bars = await queryBarsRange({
      symbol: benchmarkSymbol,
      exchange: signal.market,
      period: "1d",
      startDate: signal.asof,
      endDate: now.toISOString(),
    });
    cache.set(cacheKey, bars);
    return bars;
  } catch {
    cache.set(cacheKey, []);
    return [];
  }
}

function defaultBenchmarkForMarket(market: string): string | null {
  const normalized = market.trim().toUpperCase();
  if (normalized.includes("HK")) return "^HSI";
  if (normalized.includes("SH") || normalized.includes("SZ") || normalized.includes("CN")) {
    return "000300";
  }
  if (normalized.includes("US") || normalized === "") return "SPY";
  return null;
}

function returnBetween(bars: BarData[], startAt: string, endAt: string): number | null {
  const sorted = bars
    .filter((bar) => bar.timestamp >= startAt && bar.timestamp <= endAt)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const start = sorted[0]?.close;
  const end = sorted[sorted.length - 1]?.close;
  if (start == null || end == null || start <= 0) return null;
  return ((end - start) / start) * 100;
}
