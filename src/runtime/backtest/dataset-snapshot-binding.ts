/**
 * Backtest dataset binding — M1 的可复现性硬门。
 *
 * 回测在提交时把不可变 market snapshot 转为 Provider 可消费的窄数据集；Provider
 * 不得自行按日期重新拉行情。这里刻意不创建快照：调用者必须先显式取得并留下
 * snapshotId，避免“当前行情伪装成历史回测输入”。
 */

import {
  getMarketSnapshotById,
  type MarketSnapshotRecord,
  type SnapshotBar,
} from "../market/contracts/market-snapshot-service";
import type { BacktestDataset, BacktestDatasetBar } from "../provider/types";

export class DatasetSnapshotBindingError extends Error {
  constructor(
    public code:
      | "dataset_snapshot_required"
      | "dataset_snapshot_not_found"
      | "dataset_snapshot_invalid"
      | "dataset_snapshot_coverage_missing",
    message: string
  ) {
    super(message);
    this.name = "DatasetSnapshotBindingError";
  }
}

export async function bindBacktestDataset(input: {
  snapshotId?: string;
  symbols: string[];
  benchmark?: string;
  startDate: string;
  endDate: string;
  timeframe?: string;
}): Promise<BacktestDataset> {
  const snapshotId = input.snapshotId?.trim();
  if (!snapshotId) {
    throw new DatasetSnapshotBindingError(
      "dataset_snapshot_required",
      "dataset_snapshot_required: create or select a market.snapshot.get snapshot before backtest"
    );
  }
  const record = await getMarketSnapshotById(snapshotId);
  if (!record) {
    throw new DatasetSnapshotBindingError(
      "dataset_snapshot_not_found",
      `dataset_snapshot_not_found: ${snapshotId}`
    );
  }
  validateSnapshot(record, input);

  const requestedSymbols = [
    ...new Set([...input.symbols, ...(input.benchmark ? [input.benchmark] : [])]),
  ];
  const barsBySymbol: Record<string, BacktestDatasetBar[]> = {};
  for (const symbol of requestedSymbols) {
    const rawBars = barsForSymbol(record, symbol);
    if (!rawBars) {
      throw new DatasetSnapshotBindingError(
        "dataset_snapshot_coverage_missing",
        `dataset_snapshot_coverage_missing: ${symbol} is absent from ${snapshotId}`
      );
    }
    const bars = rawBars
      .filter((bar) => {
        const date = bar.timestamp.slice(0, 10);
        return date >= input.startDate && date <= input.endDate;
      })
      .map(toDatasetBar);
    if (bars.length === 0) {
      throw new DatasetSnapshotBindingError(
        "dataset_snapshot_coverage_missing",
        `dataset_snapshot_coverage_missing: ${symbol} has no bars in ${input.startDate}..${input.endDate}`
      );
    }
    if (!bars.every(validBar)) {
      throw new DatasetSnapshotBindingError(
        "dataset_snapshot_invalid",
        `dataset_snapshot_invalid: malformed OHLCV for ${symbol}`
      );
    }
    barsBySymbol[symbol] = bars;
  }

  return {
    snapshotId: record.snapshot.snapshotId,
    dataRef: record.dataRef,
    asOf: record.snapshot.asOf,
    timeframe: record.meta.timeframe,
    sourceIds: record.meta.sourceIds,
    tradingCalendar: {
      timezone: record.snapshot.timezone,
      ...(record.snapshot.calendarVersion ? { version: record.snapshot.calendarVersion } : {}),
      ...calendarSessionsBySymbol(record, requestedSymbols),
    },
    ...(record.snapshot.corporateActionLedger
      ? { corporateActionEvents: corporateActionEventsFor(record, input.symbols) }
      : {}),
    ...(record.snapshot.fundamentalLedger
      ? { fundamentalObservations: fundamentalObservationsFor(record, input.symbols) }
      : {}),
    barsBySymbol,
    qualification: qualificationFor(record, input.symbols, input.startDate, input.endDate),
  };
}

function fundamentalObservationsFor(
  record: MarketSnapshotRecord,
  symbols: string[]
): NonNullable<BacktestDataset["fundamentalObservations"]> {
  const observationsBySymbol = record.snapshot.fundamentalLedger?.observationsBySymbol ?? {};
  return symbols.flatMap((symbol) =>
    (observationsBySymbol[symbol.trim().toUpperCase()] ?? []).map((observation) => ({
      symbol,
      metric: observation.metric,
      fiscalPeriodEnd: observation.fiscalPeriodEnd,
      availableAt: observation.availableAt,
      value: observation.value,
      ...(observation.revisionId ? { revisionId: observation.revisionId } : {}),
    }))
  );
}

function corporateActionEventsFor(
  record: MarketSnapshotRecord,
  symbols: string[]
): NonNullable<BacktestDataset["corporateActionEvents"]> {
  const actionsBySymbol = record.snapshot.corporateActionLedger?.actionsBySymbol ?? {};
  return symbols.flatMap((symbol) =>
    (actionsBySymbol[symbol.trim().toUpperCase()] ?? []).map((action) => ({
      symbol,
      effectiveDate: action.effectiveDate,
      knownAt: action.knownAt,
      kind: action.kind,
      ...(action.cashAmount !== undefined ? { cashAmount: action.cashAmount } : {}),
    }))
  );
}

function qualificationFor(
  record: MarketSnapshotRecord,
  symbols: string[],
  startDate: string,
  endDate: string
): BacktestDataset["qualification"] {
  const adjustment = (record.snapshot.adjustMethod ?? "none").trim().toLowerCase();
  const pointInTime = record.snapshot.qualityVerdict?.pointInTime === "point_in_time_valid";
  const universeHistoryVerified = hasUniverseHistoryCoverage(record, symbols, startDate, endDate);
  const corporateActionsVerified = hasCorporateActionCoverage(record, symbols);
  const validationFeed =
    record.snapshot.sources.length > 0 &&
    record.snapshot.sources.every((source) =>
      ["L1_strategy_validation", "L2_realtime_observe", "L3_trading"].includes(
        source.feedClass ?? "L0_research_fallback"
      )
    );
  const limitations = [
    ...(universeHistoryVerified ? [] : ["universe_history_not_verified"]),
    ...(corporateActionsVerified ? [] : ["corporate_actions_not_versioned"]),
    ...(validationFeed ? [] : ["validation_feed_not_verified"]),
    ...(pointInTime ? [] : ["point_in_time_not_verified"]),
  ];
  return {
    useClass:
      pointInTime && universeHistoryVerified && corporateActionsVerified && validationFeed
        ? "strategy_validation"
        : "research_only",
    universeHistory: universeHistoryVerified ? "verified" : "not_verified",
    corporateActions: corporateActionsVerified
      ? "verified"
      : adjustment === "none" || adjustment === "raw"
        ? "raw_unadjusted"
        : "not_verified",
    pointInTime: pointInTime ? "verified" : "not_verified",
    limitations,
    ...(record.snapshot.universeHistory
      ? {
          universeHistoryRef: {
            universeId: record.snapshot.universeHistory.universeId,
            version: record.snapshot.universeHistory.version,
            source: record.snapshot.universeHistory.source,
            asOf: record.snapshot.universeHistory.asOf,
          },
        }
      : {}),
    ...(record.snapshot.corporateActionLedger
      ? {
          corporateActionLedgerRef: {
            version: record.snapshot.corporateActionLedger.version,
            source: record.snapshot.corporateActionLedger.source,
            asOf: record.snapshot.corporateActionLedger.asOf,
          },
        }
      : {}),
    ...(record.snapshot.fundamentalLedger
      ? {
          fundamentalLedgerRef: {
            version: record.snapshot.fundamentalLedger.version,
            source: record.snapshot.fundamentalLedger.source,
            asOf: record.snapshot.fundamentalLedger.asOf,
          },
        }
      : {}),
  };
}

function hasUniverseHistoryCoverage(
  record: MarketSnapshotRecord,
  symbols: string[],
  startDate: string,
  endDate: string
): boolean {
  const history = record.snapshot.universeHistory;
  const snapshotAsOf = Date.parse(record.snapshot.asOf);
  if (
    !history ||
    !isIsoDateTime(history.asOf) ||
    !Number.isFinite(snapshotAsOf) ||
    Date.parse(history.asOf) > snapshotAsOf
  ) {
    return false;
  }
  for (const symbol of symbols) {
    const bars = barsForSymbol(record, symbol) ?? [];
    const dates = bars
      .map((bar) => bar.timestamp.slice(0, 10))
      .filter((date) => date >= startDate && date <= endDate);
    if (
      dates.length === 0 ||
      !dates.every((date) =>
        history.membershipIntervals.some(
          (interval) =>
            interval.symbol.trim().toUpperCase() === symbol.trim().toUpperCase() &&
            isIsoDate(interval.startDate) &&
            (interval.endDate === undefined ||
              (isIsoDate(interval.endDate) && interval.startDate <= interval.endDate)) &&
            interval.startDate <= date &&
            (interval.endDate === undefined || interval.endDate >= date)
        )
      )
    ) {
      return false;
    }
  }
  return true;
}

function hasCorporateActionCoverage(record: MarketSnapshotRecord, symbols: string[]): boolean {
  const ledger = record.snapshot.corporateActionLedger;
  const snapshotAsOf = Date.parse(record.snapshot.asOf);
  if (
    !ledger ||
    !isIsoDateTime(ledger.asOf) ||
    !Number.isFinite(snapshotAsOf) ||
    Date.parse(ledger.asOf) > snapshotAsOf
  ) {
    return false;
  }
  const adjustment = (record.snapshot.adjustMethod ?? "none").trim().toLowerCase();
  if (ledger.adjustmentMethod.trim().toLowerCase() !== adjustment) return false;
  return symbols.every((symbol) => {
    const actions = ledger.actionsBySymbol[symbol.trim().toUpperCase()];
    return (
      Array.isArray(actions) &&
      actions.every(
        (action) =>
          isIsoDateTime(action.knownAt) &&
          isIsoDate(action.effectiveDate) &&
          Date.parse(action.knownAt) <= snapshotAsOf &&
          action.knownAt.slice(0, 10) <= action.effectiveDate
      )
    );
  });
}

function isIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

function validateSnapshot(
  record: MarketSnapshotRecord,
  input: Pick<Parameters<typeof bindBacktestDataset>[0], "startDate" | "endDate" | "timeframe">
): void {
  if ((input.timeframe ?? "1d").toLowerCase() !== record.meta.timeframe.toLowerCase()) {
    throw new DatasetSnapshotBindingError(
      "dataset_snapshot_coverage_missing",
      `dataset_snapshot_timeframe_mismatch: requested ${input.timeframe ?? "1d"}, snapshot ${record.meta.timeframe}`
    );
  }
  const window = record.snapshot.window;
  if (
    (window.start && input.startDate < window.start.slice(0, 10)) ||
    (window.end && input.endDate > window.end.slice(0, 10))
  ) {
    throw new DatasetSnapshotBindingError(
      "dataset_snapshot_coverage_missing",
      `dataset_snapshot_window_mismatch: requested ${input.startDate}..${input.endDate}, snapshot ${window.start ?? "?"}..${window.end ?? "?"}`
    );
  }
  const quality = record.snapshot.qualityVerdict;
  if (
    quality &&
    (quality.structure !== "valid" ||
      quality.completeness !== "complete" ||
      quality.pointInTime !== "point_in_time_valid")
  ) {
    throw new DatasetSnapshotBindingError(
      "dataset_snapshot_invalid",
      `dataset_snapshot_invalid: ${quality.structure}/${quality.completeness}/${quality.pointInTime}`
    );
  }
}

function barsForSymbol(record: MarketSnapshotRecord, symbol: string): SnapshotBar[] | null {
  const target = symbol.trim().toUpperCase();
  const candidates = Object.entries(record.barsByInstrument).filter(([key]) => {
    const keySymbol = key
      .slice(key.lastIndexOf(":") + 1)
      .trim()
      .toUpperCase();
    return keySymbol === target;
  });
  // A snapshot with two venues for the same bare ticker is ambiguous, and must not silently choose one.
  return candidates.length === 1 ? candidates[0]![1] : null;
}

function calendarSessionsBySymbol(
  record: MarketSnapshotRecord,
  symbols: string[]
): Pick<NonNullable<BacktestDataset["tradingCalendar"]>, "sessionsBySymbol"> {
  const byVenue = record.snapshot.calendarSessionsByVenue;
  if (!byVenue) return {};
  const sessionsBySymbol: Record<string, Record<string, "open" | "closed">> = {};
  for (const symbol of symbols) {
    const target = symbol.trim().toUpperCase();
    const matches = record.snapshot.universe.filter((instrument) => {
      const separator = instrument.lastIndexOf(":");
      return (
        separator >= 0 &&
        instrument
          .slice(separator + 1)
          .trim()
          .toUpperCase() === target
      );
    });
    if (matches.length !== 1) continue;
    const key = matches[0]!;
    const venue = key.slice(0, key.lastIndexOf(":"));
    const sessions = byVenue[venue];
    if (sessions && Object.keys(sessions).length > 0) sessionsBySymbol[symbol] = { ...sessions };
  }
  return Object.keys(sessionsBySymbol).length > 0 ? { sessionsBySymbol } : {};
}

function toDatasetBar(bar: SnapshotBar): BacktestDatasetBar {
  return {
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    turnover: bar.turnover,
    ...(bar.settlementPrice !== undefined ? { settlementPrice: bar.settlementPrice } : {}),
    ...(bar.fundingRateBps !== undefined ? { fundingRateBps: bar.fundingRateBps } : {}),
    ...(bar.impliedVolatility !== undefined ? { impliedVolatility: bar.impliedVolatility } : {}),
    ...(bar.riskFreeRateAnnual !== undefined ? { riskFreeRateAnnual: bar.riskFreeRateAnnual } : {}),
    ...(bar.tradable !== undefined ? { tradable: bar.tradable } : {}),
    ...(bar.suspended !== undefined ? { suspended: bar.suspended } : {}),
    ...(bar.priceLimitUp !== undefined ? { priceLimitUp: bar.priceLimitUp } : {}),
    ...(bar.priceLimitDown !== undefined ? { priceLimitDown: bar.priceLimitDown } : {}),
  };
}

function validBar(bar: BacktestDatasetBar): boolean {
  return (
    Number.isFinite(bar.open) &&
    Number.isFinite(bar.high) &&
    Number.isFinite(bar.low) &&
    Number.isFinite(bar.close) &&
    Number.isFinite(bar.volume) &&
    Number.isFinite(bar.turnover) &&
    (bar.settlementPrice === undefined || Number.isFinite(bar.settlementPrice)) &&
    (bar.fundingRateBps === undefined || Number.isFinite(bar.fundingRateBps)) &&
    (bar.impliedVolatility === undefined || Number.isFinite(bar.impliedVolatility)) &&
    (bar.riskFreeRateAnnual === undefined || Number.isFinite(bar.riskFreeRateAnnual)) &&
    (bar.tradable === undefined || typeof bar.tradable === "boolean") &&
    (bar.suspended === undefined || typeof bar.suspended === "boolean") &&
    (bar.priceLimitUp === undefined || Number.isFinite(bar.priceLimitUp)) &&
    (bar.priceLimitDown === undefined || Number.isFinite(bar.priceLimitDown)) &&
    bar.high >= bar.low &&
    bar.volume >= 0
  );
}
