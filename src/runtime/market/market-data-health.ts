import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { loadBuiltinConnectorSettings } from "../config/builtin-connector-settings";
import { fetchAkshareBars, fetchAkshareTencentBars } from "./akshare-klines";
import { fetchBinanceBars } from "./binance-klines";
import { fetchEastMoneyBars } from "./eastmoney-klines";
import { fetchYahooFinanceBars, type KlinesDataSourceMeta } from "./klines-data-source";
import {
  listMarketDataSources,
  marketSourceDefinition,
  marketSourceBackoffUntil,
  recordMarketDataSourceAttempt,
} from "./market-data-source-control";
import { fetchYfinanceBars } from "./yfinance-klines";
import { getWindSessionStatus } from "./wind-klines";
import { marketDataFetch } from "./market-data-network";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";

const PROBE_TIMEOUT_MS = 20_000;

export interface MarketDataReadiness {
  status: "checking" | "ready" | "degraded" | "down";
  checkedAt: string | null;
  healthySources: string[];
  readyMarkets: string[];
  targetMarkets: string[];
  message: string;
}

let readiness: MarketDataReadiness = {
  status: "checking",
  checkedAt: null,
  healthySources: [],
  readyMarkets: [],
  targetMarkets: ["CN", "US", "CRYPTO"],
  message: "行情数据源正在执行启动探针",
};

export function getMarketDataReadiness(): MarketDataReadiness {
  return readiness;
}

function probeParams(source: KlinesDataSourceMeta): FetchBarsParams {
  const end = new Date();
  const start = new Date(end.getTime() - 45 * 86_400_000);
  if (source === "binance_crypto") {
    return {
      symbol: "BTCUSDT",
      exchange: "CRYPTO",
      period: "1d",
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }
  if (
    source === "eastmoney" ||
    source === "akshare" ||
    source === "akshare_tencent" ||
    source === "tushare_daily" ||
    source === "wind"
  ) {
    return {
      symbol: "600000",
      exchange: "SH",
      period: "1d",
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }
  return {
    symbol: "AAPL",
    exchange: "US",
    period: "1d",
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}

async function probeTushare(
  params: FetchBarsParams,
  token: string,
  settings: BuiltinConnectorInitConfigs,
): Promise<BarData[]> {
  const res = await marketDataFetch("tushare_daily", settings, "https://api.tushare.pro", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_name: "daily",
      token,
      params: {
        ts_code: "600000.SH",
        start_date: params.startDate.slice(0, 10).replaceAll("-", ""),
        end_date: params.endDate.slice(0, 10).replaceAll("-", ""),
      },
      fields: "ts_code,trade_date,open,high,low,close,vol,amount",
    }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tushare HTTP ${res.status}: ${text.slice(0, 160)}`);
  const json = JSON.parse(text) as { code?: number; msg?: string; data?: { items?: unknown[][] } };
  if (json.code && json.code !== 0) throw new Error(`tushare code=${json.code}: ${json.msg ?? "unknown"}`);
  return (json.data?.items ?? []).map((_, i) => ({
    symbol: "600000",
    exchange: "SH",
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
    turnover: 0,
    timestamp: new Date(Date.now() - i * 86_400_000).toISOString(),
  }));
}

async function probeOne(sourceId: KlinesDataSourceMeta, ignoreBackoff = false): Promise<boolean> {
  const settings = await loadBuiltinConnectorSettings();
  const source = (await listMarketDataSources()).find((s) => s.id === sourceId);
  const params = probeParams(sourceId);
  const market = source?.supportedMarkets[0] ?? "UNKNOWN";
  const started = Date.now();
  try {
    if (!source || source.status !== "active") throw new Error("source disabled");
    if (!source.credentialsReady) {
      await recordMarketDataSourceAttempt({
        sourceId,
        market,
        timeframe: "1d",
        symbol: params.symbol,
        status: "blocked",
        latencyMs: Date.now() - started,
        error: `credentials missing (${source.credentialMode})`,
        healthcheck: true,
      });
      return false;
    }
    const backoffUntil = ignoreBackoff ? null : marketSourceBackoffUntil(sourceId);
    if (backoffUntil) {
      await recordMarketDataSourceAttempt({
        sourceId,
        market,
        timeframe: "1d",
        symbol: params.symbol,
        status: "blocked",
        latencyMs: Date.now() - started,
        error: `shared upstream backoff until ${new Date(backoffUntil).toISOString()}`,
        healthcheck: true,
      });
      return false;
    }
    let bars: BarData[] = [];
    if (sourceId === "yahoo_chart") bars = await fetchYahooFinanceBars(params, settings);
    else if (sourceId === "eastmoney") bars = await fetchEastMoneyBars(params, settings);
    else if (sourceId === "akshare") bars = await fetchAkshareBars(params, settings);
    else if (sourceId === "akshare_tencent") bars = await fetchAkshareTencentBars(params, settings);
    else if (sourceId === "yfinance") bars = await fetchYfinanceBars(params, settings);
    else if (sourceId === "binance_crypto") {
      bars = await fetchBinanceBars(params, settings["qubit-data"]);
    } else if (sourceId === "tushare_daily") {
      const token = String(settings["qubit-data"]?.tushareToken ?? "").trim();
      bars = await probeTushare(params, token, settings);
    } else if (sourceId === "wind") {
      const session = await getWindSessionStatus(settings);
      if (!session.connected) throw new Error(session.message || "Wind terminal not connected");
      bars = [{ ...params, open: 0, high: 0, low: 0, close: 0, volume: 0, turnover: 0, timestamp: new Date().toISOString() } as BarData];
    }
    if (bars.length === 0) throw new Error("health probe returned no rows");
    await recordMarketDataSourceAttempt({
      sourceId,
      market,
      timeframe: "1d",
      symbol: params.symbol,
      status: "success",
      latencyMs: Date.now() - started,
      healthcheck: true,
    });
    return true;
  } catch (e) {
    await recordMarketDataSourceAttempt({
      sourceId,
      market,
      timeframe: "1d",
      symbol: params.symbol,
      status: "error",
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
      healthcheck: true,
    });
    return false;
  }
}

export async function runMarketDataHealthChecks(sourceId?: string): Promise<MarketDataReadiness> {
  const all = await listMarketDataSources();
  const ids = sourceId
    ? all.filter((s) => s.id === sourceId).map((s) => s.id as KlinesDataSourceMeta)
    : all.map((s) => s.id as KlinesDataSourceMeta);
  const results: Array<{ id: KlinesDataSourceMeta; ok: boolean }> = [];
  if (sourceId) {
    const id = ids[0];
    if (id) results.push({ id, ok: await probeOne(id, true) });
  } else {
    const groups = new Map<string, KlinesDataSourceMeta[]>();
    for (const id of ids) {
      const family = marketSourceDefinition(id)?.upstreamFamily ?? id;
      groups.set(family, [...(groups.get(family) ?? []), id]);
    }
    const groupedResults = await Promise.all(
      [...groups.values()].map(async (familyIds) => {
        const familyResults: Array<{ id: KlinesDataSourceMeta; ok: boolean }> = [];
        for (const id of familyIds) familyResults.push({ id, ok: await probeOne(id) });
        return familyResults;
      }),
    );
    results.push(...groupedResults.flat());
  }
  const refreshed = await listMarketDataSources();
  const healthySources = refreshed.filter((s) => s.healthStatus === "healthy").map((s) => s.id);
  const readyMarkets = Array.from(
    new Set(
      refreshed
        .filter((s) => s.healthStatus === "healthy" && s.status === "active")
        .flatMap((s) => s.supportedMarkets)
    )
  );
  const targetMarkets = readiness.targetMarkets;
  const targetReady = targetMarkets.filter((market) => readyMarkets.includes(market));
  const status: MarketDataReadiness["status"] =
    healthySources.length === 0
      ? "down"
      : targetReady.length === targetMarkets.length
        ? "ready"
        : "degraded";
  readiness = {
    status,
    checkedAt: new Date().toISOString(),
    healthySources,
    readyMarkets,
    targetMarkets,
    message:
      status === "ready"
        ? `目标市场均有可用数据源：${targetMarkets.join(" / ")}`
        : status === "degraded"
          ? `部分市场可用（${targetReady.join(" / ") || "无目标市场"}）；请求将按健康度降级`
          : "没有数据源通过真实样本探针；行情工具将明确返回 unavailable",
  };
  console.log(
    `[MarketData] readiness=${status} healthy=${healthySources.join(",") || "none"} probes=${results.map((r) => `${r.id}:${r.ok ? "ok" : "fail"}`).join(",")}`
  );
  return readiness;
}

export async function runMarketDataReadinessGate(): Promise<MarketDataReadiness> {
  readiness = { ...readiness, status: "checking", message: "行情数据源正在执行启动探针" };
  return runMarketDataHealthChecks();
}
