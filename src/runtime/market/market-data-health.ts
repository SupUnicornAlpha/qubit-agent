import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { getDb } from "../../db/sqlite/client";
import { marketDataSource } from "../../db/sqlite/schema";
import { eq } from "drizzle-orm";
import { loadBuiltinConnectorSettings } from "../config/builtin-connector-settings";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import { fetchAkshareBars, fetchAkshareTencentBars } from "./akshare-klines";
import { fetchBinanceBars } from "./binance-klines";
import { fetchEastMoneyBars } from "./eastmoney-klines";
import {
  bridgeIdForSourceId,
  isBrokerMarketBridgeSourceId,
  resolveBridgeWsUrl,
} from "./broker-market-bridge";
import { type KlinesDataSourceMeta, fetchYahooFinanceBars } from "./klines-data-source";
import { formatMarketDataFailure } from "./market-data-errors";
import { marketDataFetch } from "./market-data-network";
import {
  type OperationalMarketDataSource,
  listMarketDataSources,
  marketSourceBackoffUntil,
  marketSourceDefinition,
  recordMarketDataSourceAttempt,
} from "./market-data-source-control";
import { queryMarketQuote } from "./microstructure-query";
import { getWindSessionStatus } from "./wind-klines";
import { fetchYfinanceBars } from "./yfinance-klines";
import { fetchFutuBars } from "./futu-klines";
import { fetchIbBars } from "./ib-klines";
import { fetchIfindBars } from "./ifind-klines";

const PROBE_TIMEOUT_MS = 20_000;

async function probeWsListenPort(wsUrl: string): Promise<boolean> {
  try {
    const httpish = wsUrl.replace(/^ws/i, "http");
    const u = new URL(httpish);
    const host = u.hostname || "127.0.0.1";
    const port = u.port ? Number(u.port) : wsUrl.startsWith("wss") ? 443 : 80;
    const conn = await Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          socket.end();
        },
        data() {},
        error() {},
        close() {},
      },
    });
    try {
      conn.end();
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

export interface MarketDataReadiness {
  status: "checking" | "ready" | "degraded" | "down";
  checkedAt: string | null;
  healthySources: string[];
  readyMarkets: string[];
  realtimeHealthySources: string[];
  realtimeReadyMarkets: string[];
  targetMarkets: string[];
  scope: "historical_and_realtime";
  message: string;
}

let readiness: MarketDataReadiness = {
  status: "checking",
  checkedAt: null,
  healthySources: [],
  readyMarkets: [],
  realtimeHealthySources: [],
  realtimeReadyMarkets: [],
  targetMarkets: ["CN", "US", "CRYPTO"],
  scope: "historical_and_realtime",
  message: "行情数据源正在执行历史与实时能力探针",
};

export function getMarketDataReadiness(): MarketDataReadiness {
  return readiness;
}

function probeParams(source: OperationalMarketDataSource | KlinesDataSourceMeta): FetchBarsParams {
  const end = new Date();
  const start = new Date(end.getTime() - 45 * 86_400_000);
  if (isBrokerMarketBridgeSourceId(source)) {
    return {
      symbol: source === "ib_bridge" ? "AAPL" : "600000",
      exchange: source === "ib_bridge" ? "US" : "SH",
      period: "1d",
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };
  }
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
  settings: BuiltinConnectorInitConfigs
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
  if (json.code && json.code !== 0)
    throw new Error(`tushare code=${json.code}: ${json.msg ?? "unknown"}`);
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

async function probeOne(
  sourceId: OperationalMarketDataSource | KlinesDataSourceMeta,
  ignoreBackoff = false
): Promise<boolean> {
  const settings = await loadBuiltinConnectorSettings();
  const source = (await listMarketDataSources()).find((s) => s.id === sourceId);
  const params = probeParams(sourceId);
  const market = source?.supportedMarkets[0] ?? "UNKNOWN";
  const started = Date.now();
  try {
    if (!source || source.status !== "active") throw new Error("source disabled");
    if (!source.credentialsReady) {
      const bridgeHint = isBrokerMarketBridgeSourceId(sourceId)
        ? " — 仅启动 OpenD 不够：需配置启用的 Futu 券商账户，并确保行情桥（QUBIT_FUTU_MARKET_WS_URL / POST …/bridges/futu/ensure）"
        : "";
      await recordMarketDataSourceAttempt({
        sourceId,
        market,
        timeframe: "1d",
        symbol: params.symbol,
        status: "blocked",
        latencyMs: Date.now() - started,
        error: `credentials missing (${source.credentialMode})${bridgeHint}`,
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
    // Broker bridges with historical K-line: history probe must succeed to mark healthy.
    // Quote WS-only must NOT mark healthy — that caused auto to route history to a
    // broken OpenQuote path (e.g. missing futu-api) while UI showed "健康".
    if (sourceId === "futu_bridge" || sourceId === "ib_bridge" || sourceId === "supermind_bridge") {
      const bridgeId =
        sourceId === "futu_bridge" ? "futu" : sourceId === "ib_bridge" ? "ib" : "supermind";
      let historyErr: string | null = null;
      try {
        const bars =
          sourceId === "futu_bridge"
            ? await fetchFutuBars(params)
            : sourceId === "ib_bridge"
              ? await fetchIbBars(params)
              : await fetchIfindBars(params, settings);
        if (bars.length > 0) {
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
        }
        historyErr = `${sourceId} history returned empty`;
      } catch (e) {
        historyErr = e instanceof Error ? e.message : String(e);
      }
      const wsUrl = resolveBridgeWsUrl(bridgeId);
      const wsOk = Boolean(wsUrl && (await probeWsListenPort(wsUrl)));
      await recordMarketDataSourceAttempt({
        sourceId,
        market,
        timeframe: "1d",
        symbol: params.symbol,
        status: "error",
        latencyMs: Date.now() - started,
        error: historyErr ?? "history unavailable",
        healthcheck: true,
      });
      // Keep quote-port signal in lastError suffix for ops; never treat WS-only as healthy.
      if (wsOk) {
        const db = await getDb();
        await db
          .update(marketDataSource)
          .set({
            healthStatus: "degraded",
            lastError: formatMarketDataFailure(
              `${historyErr ?? "history unavailable"} (quote WS listening)`
            ),
            lastHealthcheckAt: new Date().toISOString(),
            circuitState: "closed",
            circuitOpenedAt: null,
            consecutiveFailures: 0,
          })
          .where(eq(marketDataSource.id, sourceId));
      }
      return false;
    }
    if (isBrokerMarketBridgeSourceId(sourceId)) {
      const bridgeId = bridgeIdForSourceId(sourceId);
      const wsUrl = bridgeId ? resolveBridgeWsUrl(bridgeId) : undefined;
      if (!wsUrl) {
        throw new Error(
          "quote bridge WS URL not configured (QUBIT_FUTU_MARKET_WS_URL / ensure futu bridges)"
        );
      }
      const portOpen = await probeWsListenPort(wsUrl);
      if (!portOpen) {
        throw new Error(`quote bridge not listening at ${wsUrl}`);
      }
      await recordMarketDataSourceAttempt({
        sourceId,
        market,
        timeframe: "quote",
        symbol: params.symbol,
        status: "success",
        latencyMs: Date.now() - started,
        healthcheck: true,
      });
      return true;
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
      bars = [
        {
          ...params,
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          volume: 0,
          turnover: 0,
          timestamp: new Date().toISOString(),
        } as BarData,
      ];
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

export function isQuoteFreshForReadiness(
  market: "CN" | "CRYPTO",
  freshnessMs: number,
  now = new Date()
): boolean {
  if (!Number.isFinite(freshnessMs) || freshnessMs < 0) return false;
  if (market === "CRYPTO") return freshnessMs <= 2 * 60_000;

  // China Standard Time without relying on the host timezone.
  const cn = new Date(now.getTime() + 8 * 60 * 60_000);
  const weekday = cn.getUTCDay();
  const minutes = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  const duringTradingSession =
    weekday >= 1 &&
    weekday <= 5 &&
    ((minutes >= 9 * 60 + 15 && minutes <= 11 * 60 + 35) ||
      (minutes >= 12 * 60 + 55 && minutes <= 15 * 60 + 10));
  return duringTradingSession ? freshnessMs <= 5 * 60_000 : freshnessMs <= 4 * 86_400_000;
}

async function probeRealtimeOne(market: "CN" | "CRYPTO"): Promise<{
  market: "CN" | "CRYPTO";
  sourceId: "eastmoney" | "akshare_tencent" | "binance_crypto";
  ok: boolean;
}> {
  const symbol = market === "CN" ? "600000.SH" : "BTCUSDT";
  const exchange = market === "CN" ? "SH" : "CRYPTO";
  try {
    const quote = await queryMarketQuote({ symbol, exchange });
    if (!isQuoteFreshForReadiness(market, quote.freshnessMs)) {
      throw new Error(
        `stale realtime quote: asof=${quote.timestamp}, freshnessMs=${quote.freshnessMs}`
      );
    }
    const sourceId =
      market === "CRYPTO"
        ? "binance_crypto"
        : quote.source === "tencent"
          ? "akshare_tencent"
          : "eastmoney";
    return { market, sourceId, ok: true };
  } catch {
    return {
      market,
      sourceId: market === "CN" ? "eastmoney" : "binance_crypto",
      ok: false,
    };
  }
}

export async function runMarketDataHealthChecks(sourceId?: string): Promise<MarketDataReadiness> {
  const all = await listMarketDataSources();
  const ids = sourceId
    ? all.filter((s) => s.id === sourceId).map((s) => s.id as OperationalMarketDataSource)
    : all.map((s) => s.id as OperationalMarketDataSource);
  const results: Array<{ id: OperationalMarketDataSource; ok: boolean }> = [];
  if (sourceId) {
    const id = ids[0];
    if (id) results.push({ id, ok: await probeOne(id, true) });
  } else {
    const groups = new Map<string, OperationalMarketDataSource[]>();
    for (const id of ids) {
      const family = marketSourceDefinition(id)?.upstreamFamily ?? id;
      groups.set(family, [...(groups.get(family) ?? []), id]);
    }
    const groupedResults = await Promise.all(
      [...groups.values()].map(async (familyIds) => {
        const familyResults: Array<{ id: OperationalMarketDataSource; ok: boolean }> = [];
        for (const id of familyIds) familyResults.push({ id, ok: await probeOne(id) });
        return familyResults;
      })
    );
    results.push(...groupedResults.flat());
  }
  const realtimeResults = sourceId
    ? sourceId === "eastmoney"
      ? [await probeRealtimeOne("CN")]
      : sourceId === "binance_crypto"
        ? [await probeRealtimeOne("CRYPTO")]
        : []
    : await Promise.all([probeRealtimeOne("CN"), probeRealtimeOne("CRYPTO")]);
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
  const realtimeHealthySources = realtimeResults
    .filter((result) => result.ok)
    .map((result) => result.sourceId);
  const realtimeReadyMarkets = realtimeResults
    .filter((result) => result.ok)
    .map((result) => result.market);
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
    realtimeHealthySources,
    realtimeReadyMarkets,
    targetMarkets,
    scope: "historical_and_realtime",
    message:
      status === "ready"
        ? `历史 K 线可用：${targetMarkets.join(" / ")}；实时 Quote 可用：${realtimeReadyMarkets.join(" / ") || "无"}`
        : status === "degraded"
          ? `历史 K 线部分可用（${targetReady.join(" / ") || "无目标市场"}）；实时 Quote 可用：${realtimeReadyMarkets.join(" / ") || "无"}`
          : `没有历史数据源通过真实样本探针；实时 Quote 可用：${realtimeReadyMarkets.join(" / ") || "无"}`,
  };
  console.log(
    `[MarketData] readiness=${status} healthy=${healthySources.join(",") || "none"} probes=${results.map((r) => `${r.id}:${r.ok ? "ok" : "fail"}`).join(",")}`
  );
  return readiness;
}

export async function runMarketDataReadinessGate(): Promise<MarketDataReadiness> {
  readiness = {
    ...readiness,
    status: "checking",
    message: "行情数据源正在执行历史与实时能力探针",
  };
  return runMarketDataHealthChecks();
}
