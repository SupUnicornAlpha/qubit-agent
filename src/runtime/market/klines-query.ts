import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { connectorRegistry } from "../../connectors/registry";
import { loadBuiltinConnectorSettings } from "../config/builtin-connector-settings";
import { parseKlinesDataSourceSetting, resolveEffectiveKlinesSource, type KlinesDataSourceMeta } from "./klines-data-source";
import { windConfigFromSettings } from "./wind-klines";
import {
  buildKlinesConnectorUnavailableError,
  buildKlinesEmptyError,
  buildKlinesInvalidRequestError,
  type KlinesErrorPayload,
} from "./klines-error";
import {
  buildKlinesQueryKey,
  getCachedKlinesBars,
  getCachedKlinesSource,
  setCachedKlinesBars,
} from "./klines-request-cache";

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

/**
 * Computes inclusive-ish [startDate, endDate] in ISO8601 for `fetch_bars`.
 * End anchors to UTC start-of-day for daily+; intraday uses current UTC time as end.
 */
export function computeDateRangeForLimit(
  timeframe: string,
  limit: number
): { startDate: string; endDate: string; period: FetchBarsParams["period"] } {
  const period = timeframeToPeriod(timeframe);
  const tf = normalizeTimeframe(timeframe);
  const n = Math.max(1, Math.min(limit, 2000));
  const win = timeframeWindowMs(tf, period) * (n - 1);

  const endDaily = new Date();
  endDaily.setUTCHours(0, 0, 0, 0);

  if (period === "1d") {
    const endMs = endDaily.getTime();
    const startMs = endMs - win;
    return {
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(endMs).toISOString(),
      period,
    };
  }

  const endMs = Date.now();
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

  const { startDate, endDate, period } = computeDateRangeForLimit(timeframe, requestedLimit);

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
  const configuredDataSource = resolveEffectiveKlinesSource({
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
  };

  const queryKey = buildKlinesQueryKey({
    symbol,
    exchange,
    period,
    startDate,
    endDate,
  });
  const cached = getCachedKlinesBars(queryKey);
  const bars =
    cached ??
    ((await connector.execute("fetch_bars", fetchParams)) as BarData[]);
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
  const raw =
    cached ??
    ((await connector.execute("fetch_bars", fetchParams)) as BarData[]);
  const sorted = [...raw].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (!cached && sorted.length > 0) {
    setCachedKlinesBars(queryKey, sorted, params.workflowRunId);
  }
  return sorted;
}
