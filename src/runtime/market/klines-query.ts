import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { connectorRegistry } from "../../connectors/registry";
import { loadBuiltinConnectorSettings } from "../config/builtin-connector-settings";
import {
  type KlinesDataSourceMeta,
  parseKlinesDataSourceSetting,
  resolveEffectiveKlinesSource,
} from "./klines-data-source";
import {
  type KlinesErrorPayload,
  buildKlinesConnectorUnavailableError,
  buildKlinesEmptyError,
  buildKlinesInvalidRequestError,
} from "./klines-error";
import {
  buildKlinesQueryKey,
  getCachedKlinesBars,
  getCachedKlinesSource,
  setCachedKlinesBars,
} from "./klines-request-cache";
import { windConfigFromSettings } from "./wind-klines";

/** Query token (case-insensitive). `1W` normalizes to daily bars spanning `limit` weeks. */
const TIMEFRAME_TO_PERIOD: Record<string, FetchBarsParams["period"]> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1h",
  "4h": "4h",
  "1d": "1d",
  "1w": "1d",
};

const DEFAULT_TIMEFRAME = "1d";
const inFlightKlines = new Map<string, Promise<BarData[]>>();

function normalizeTimeframe(raw: string | undefined): string {
  const t = (raw ?? DEFAULT_TIMEFRAME).trim().toLowerCase();
  if (!t) return DEFAULT_TIMEFRAME;
  return t;
}

/** Maps UI timeframe to `FetchBarsParams.period` (weekly → daily bars). */
export function timeframeToPeriod(timeframe: string): FetchBarsParams["period"] {
  const key = normalizeTimeframe(timeframe);
  return TIMEFRAME_TO_PERIOD[key] ?? "1d";
}

const H_MS = 3_600_000;
const D_MS = 86_400_000;
/**
 * Daily requests are expressed in *bars*, while calendar windows include weekends,
 * exchange holidays and occasional closures.  A 1.55x buffer reliably covers a
 * 252-trading-day year without asking callers to know the exchange calendar.
 */
const DAILY_BAR_CALENDAR_BUFFER = 1.55;
/**
 * Intraday bars only exist during regular sessions (~6.5h US equity day).
 * `limit * barMs` alone collapses into overnight/weekend emptiness — e.g. Monday
 * morning asking for 250×5m ≈ 21 wall-clock hours that contain almost no prints.
 * Expand by session denseness and a weekend pad, with a per-period floor lookback
 * (still within Yahoo's typical intraday history caps).
 */
const INTRADAY_SESSION_DENSITY = 24 / 6.5;
const INTRADAY_WEEKEND_PAD_MS = 3 * D_MS;
const INTRADAY_MIN_LOOKBACK_MS: Record<FetchBarsParams["period"], number> = {
  "1m": 7 * D_MS,
  "5m": 10 * D_MS,
  "15m": 14 * D_MS,
  "30m": 21 * D_MS,
  "1h": 30 * D_MS,
  "4h": 60 * D_MS,
  "1d": 0,
};
/** Soft cap so we do not request ranges Yahoo silently truncates to empty. */
const INTRADAY_MAX_LOOKBACK_MS: Record<FetchBarsParams["period"], number> = {
  "1m": 30 * D_MS,
  "5m": 60 * D_MS,
  "15m": 60 * D_MS,
  "30m": 60 * D_MS,
  "1h": 730 * D_MS,
  "4h": 730 * D_MS,
  "1d": Number.POSITIVE_INFINITY,
};

/** Bar duration in ms for expanding `limit` into a calendar window (approximate for 1w). */
export function timeframeWindowMs(timeframe: string, period: FetchBarsParams["period"]): number {
  const tf = normalizeTimeframe(timeframe);
  if (tf === "1w") return 7 * D_MS;
  switch (period) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "15m":
      return 15 * 60_000;
    case "30m":
      return 30 * 60_000;
    case "1h":
      return H_MS;
    case "4h":
      return 4 * H_MS;
    default:
      return D_MS;
  }
}

function intradayLookbackMs(period: FetchBarsParams["period"], barCount: number): number {
  const raw = timeframeWindowMs(period, period) * Math.max(0, barCount - 1) * INTRADAY_SESSION_DENSITY;
  const floored = Math.max(raw + INTRADAY_WEEKEND_PAD_MS, INTRADAY_MIN_LOOKBACK_MS[period] ?? 7 * D_MS);
  const capped = INTRADAY_MAX_LOOKBACK_MS[period] ?? 60 * D_MS;
  return Math.min(floored, capped);
}

/**
 * Computes inclusive-ish [startDate, endDate] in ISO8601 for `fetch_bars`.
 * End anchors to UTC start-of-day for daily+; intraday uses current UTC time as end.
 */
export function computeDateRangeForLimit(
  timeframe: string,
  limit: number,
  asOfMs: number = Date.now()
): { startDate: string; endDate: string; period: FetchBarsParams["period"] } {
  const period = timeframeToPeriod(timeframe);
  const tf = normalizeTimeframe(timeframe);
  const n = Math.max(1, Math.min(limit, 2000));
  const win =
    period === "1d" && tf !== "1w"
      ? Math.ceil((n - 1) * DAILY_BAR_CALENDAR_BUFFER) * D_MS
      : period === "1d"
        ? timeframeWindowMs(tf, period) * (n - 1)
        : intradayLookbackMs(period, n);

  if (period === "1d") {
    const endDaily = new Date(asOfMs);
    endDaily.setUTCHours(0, 0, 0, 0);
    const endMs = endDaily.getTime();
    const startMs = endMs - win;
    return {
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(endMs).toISOString(),
      period,
    };
  }

  const endMs = asOfMs;
  const startMs = endMs - win;
  return {
    startDate: new Date(startMs).toISOString(),
    endDate: new Date(endMs).toISOString(),
    period,
  };
}

export type KlinesMeta = {
  timeframe: string;
  period: FetchBarsParams["period"];
  /** 与 `QubitNativeDataConnector` 内 `resolveEffectiveKlinesSource` 一致（供前端展示）。 */
  dataSource: KlinesDataSourceMeta;
  requestedLimit: number;
  returned: number;
};

export async function queryKlines(params: {
  symbol: string;
  exchange?: string;
  timeframe?: string;
  limit?: number;
  /** 行情控制面已解析的首选源；优先访问该源，失败时仍会回退其它可用源。 */
  source?: string;
  /** Point-in-time anchor for the requested window (ms since epoch). */
  asOfMs?: number;
  /** Sparkline / preview: one upstream attempt, empty instead of fallback waterfall. */
  bestEffort?: boolean;
}): Promise<{ bars: BarData[]; meta: KlinesMeta; error?: KlinesErrorPayload }> {
  const symbol = params.symbol?.trim();
  if (!symbol) {
    return {
      bars: [],
      meta: {
        timeframe: normalizeTimeframe(params.timeframe),
        period: timeframeToPeriod(params.timeframe ?? DEFAULT_TIMEFRAME),
        dataSource: "synthetic",
        requestedLimit: Math.max(1, Math.min(params.limit ?? 300, 2000)),
        returned: 0,
      },
      error: buildKlinesInvalidRequestError("symbol is required"),
    };
  }
  const exchange = params.exchange?.trim() ?? "";
  const timeframe = normalizeTimeframe(params.timeframe);
  const requestedLimit = Math.max(1, Math.min(params.limit ?? 300, 2000));
  const routedSource =
    params.source && params.source !== "synthetic"
      ? (params.source as Exclude<KlinesDataSourceMeta, "synthetic">)
      : undefined;

  const { startDate, endDate, period } = computeDateRangeForLimit(
    timeframe,
    requestedLimit,
    params.asOfMs ?? Date.now()
  );

  const connector = connectorRegistry.get("qubit-data");
  if (!connector) {
    return {
      bars: [],
      meta: {
        timeframe,
        period,
        dataSource: "synthetic",
        requestedLimit,
        returned: 0,
      },
      error: buildKlinesConnectorUnavailableError(),
    };
  }

  const settings = await loadBuiltinConnectorSettings();
  const token = (settings["qubit-data"] as Record<string, unknown> | undefined)?.tushareToken;
  const hasTushare = typeof token === "string" && token.trim().length > 0;
  const klinesMode = parseKlinesDataSourceSetting(
    (settings["qubit-data"] as Record<string, unknown> | undefined)?.klinesDataSource
  );
  const windCfg = windConfigFromSettings(settings);
  const hasWindAvailable =
    klinesMode === "wind" || (klinesMode === "auto" && Boolean(windCfg.username));
  const configuredDataSource =
    routedSource ??
    resolveEffectiveKlinesSource({
      settings,
      period,
      hasTushareToken: hasTushare,
      hasWindAvailable,
      symbol,
      exchange,
    });

  const fetchParams: FetchBarsParams = {
    symbol,
    exchange,
    period,
    startDate,
    endDate,
    ...(routedSource ? { dataSource: routedSource } : {}),
    ...(params.bestEffort ? { bestEffort: true } : {}),
  };

  const queryKey = buildKlinesQueryKey({
    symbol,
    exchange,
    period,
    startDate,
    endDate,
  });
  const cached = getCachedKlinesBars(queryKey);
  const inFlightKey = `${queryKey}|${routedSource ?? "auto"}`;
  let bars: BarData[];
  if (cached) {
    bars = cached;
  } else {
    let pending = inFlightKlines.get(inFlightKey);
    if (!pending) {
      pending = connector.execute("fetch_bars", fetchParams) as Promise<BarData[]>;
      inFlightKlines.set(inFlightKey, pending);
    }
    try {
      bars = await pending;
    } finally {
      if (inFlightKlines.get(inFlightKey) === pending) {
        inFlightKlines.delete(inFlightKey);
      }
    }
  }
  const actualDataSource = getCachedKlinesSource(queryKey);
  if (!cached && bars.length > 0) {
    setCachedKlinesBars(queryKey, bars, undefined, actualDataSource);
  }
  const dataSource = actualDataSource ?? configuredDataSource;
  const sorted = [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const trimmed =
    sorted.length > requestedLimit ? sorted.slice(sorted.length - requestedLimit) : sorted;

  const meta: KlinesMeta = {
    timeframe,
    period,
    dataSource,
    requestedLimit,
    returned: trimmed.length,
  };

  if (trimmed.length === 0) {
    return {
      bars: trimmed,
      meta,
      error: buildKlinesEmptyError({
        symbol,
        exchange,
        timeframe,
        period,
        dataSource,
        requestedLimit,
      }),
    };
  }

  return { bars: trimmed, meta };
}

/** Fetch sorted OHLCV bars for an explicit window (backtests / experiments). */
export async function queryBarsRange(params: {
  symbol: string;
  exchange?: string;
  period: FetchBarsParams["period"];
  startDate: string;
  endDate: string;
  /** 同一 workflow 内复用 K 线缓存（C 类冗余治理） */
  workflowRunId?: string;
}): Promise<BarData[]> {
  const connector = connectorRegistry.get("qubit-data");
  if (!connector) {
    throw new Error("qubit-data connector is not registered");
  }
  const sym = params.symbol?.trim();
  if (!sym) throw new Error("symbol is required");
  const exchange = params.exchange?.trim() ?? "";
  const fetchParams: FetchBarsParams = {
    symbol: sym,
    exchange,
    period: params.period,
    startDate: params.startDate,
    endDate: params.endDate,
  };
  const queryKey = buildKlinesQueryKey({
    symbol: sym,
    exchange,
    period: params.period,
    startDate: params.startDate,
    endDate: params.endDate,
  });
  const cached = getCachedKlinesBars(queryKey, params.workflowRunId);
  const raw = cached ?? ((await connector.execute("fetch_bars", fetchParams)) as BarData[]);
  const sorted = [...raw].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!cached && sorted.length > 0) {
    setCachedKlinesBars(queryKey, sorted, params.workflowRunId);
  }
  return sorted;
}
