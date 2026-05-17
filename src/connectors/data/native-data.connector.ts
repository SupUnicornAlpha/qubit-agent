import {
  type BuiltinConnectorInitConfigs,
  loadBuiltinConnectorSettings,
} from "../../runtime/config/builtin-connector-settings";
import { fetchAkshareBars } from "../../runtime/market/akshare-klines";
import { fetchEastMoneyBars, isChinaAShareMarket } from "../../runtime/market/eastmoney-klines";
import {
  fetchYahooFinanceBars,
  parseKlinesDataSourceSetting,
  resolveEffectiveKlinesSource,
  symbolToYahooSymbol,
} from "../../runtime/market/klines-data-source";
import { computeDateRangeForLimit } from "../../runtime/market/klines-query";
import type { ConnectorConfig, ConnectorMeta, HealthCheckResult } from "../../types/connector";
import {
  type BarData,
  DataConnector,
  type FetchBarsParams,
  type FetchFundamentalsParams,
  type FetchNewsParams,
  type FetchTicksParams,
  type FundamentalData,
  type NewsData,
  type TickData,
} from "./data.connector";

const TUSHARE_ENDPOINT = "https://api.tushare.pro";

function cfgStr(config: ConnectorConfig, key: string): string | undefined {
  const v = config[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function parseIsoToYmd(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso.replace(/-/g, "").slice(0, 8);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** Map agent symbol + exchange to Tushare ts_code (e.g. 600000.SH). */
export function symbolToTsCode(symbol: string, exchange: string): string {
  const s = symbol.trim();
  if (s.includes(".")) return s.toUpperCase();
  const digits = s.replace(/\D/g, "").slice(-6).padStart(6, "0");
  const ex = exchange.trim().toUpperCase();
  if (ex.includes("SH") || ex === "SSE" || ex === "XSHG") return `${digits}.SH`;
  if (ex.includes("SZ") || ex === "SZSE" || ex === "XSHE") return `${digits}.SZ`;
  return `${digits}.SH`;
}

interface TushareDailyPayload {
  fields?: string[];
  items?: unknown[][];
}

async function tushareCall(
  token: string,
  apiName: string,
  params: Record<string, string>
): Promise<TushareDailyPayload> {
  const res = await fetch(TUSHARE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_name: apiName, token, params }),
  });
  const json = (await res.json()) as {
    code?: number;
    msg?: string;
    message?: string;
    data?: TushareDailyPayload;
  };
  if (!res.ok) {
    throw new Error(`Tushare HTTP ${res.status}`);
  }
  if (json.code !== 0) {
    throw new Error(`Tushare: ${json.msg ?? json.message ?? "request failed"}`);
  }
  return json.data ?? {};
}

function tushareTokenFromSettings(
  settings: BuiltinConnectorInitConfigs,
  fallback?: string | undefined
): string | undefined {
  const raw = settings["qubit-data"]?.tushareToken;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return fallback?.trim() || undefined;
}

function idx(fields: string[], name: string): number {
  return fields.indexOf(name);
}

/**
 * Built-in market data connector: K 线由 `klinesDataSource` 配置（见配置中心）。
 * 无外源或请求失败时不返回模拟数据，仅返回空数组并在服务端打印原因。
 */
export class QubitNativeDataConnector extends DataConnector {
  readonly meta: ConnectorMeta = {
    name: "qubit-data",
    version: "0.1.0",
    connectorType: "data",
    capabilities: [
      "fetch_bars",
      "fetch_klines",
      "fetch_ticks",
      "fetch_news",
      "fetch_fundamentals",
      "write_snapshot",
    ],
    assetClasses: ["stock"],
    latencyProfile: "batch",
    description:
      "Built-in market data: daily (Tushare / East Money / Yahoo) and intraday OHLCV (East Money A-share / Yahoo); empty when unavailable.",
  };

  private tushareToken: string | undefined;

  protected async onInit(config: ConnectorConfig): Promise<void> {
    this.tushareToken = cfgStr(config, "tushareToken");
  }

  protected async onShutdown(): Promise<void> {}

  protected async onHealthcheck(): Promise<Omit<HealthCheckResult, "latencyMs" | "checkedAt">> {
    const liveSettings = await loadBuiltinConnectorSettings();
    const tokenLive = tushareTokenFromSettings(liveSettings, this.tushareToken);
    const hasToken = Boolean(tokenLive);
    const daily = resolveEffectiveKlinesSource({
      settings: liveSettings,
      period: "1d",
      hasTushareToken: hasToken,
    });
    const intraday = resolveEffectiveKlinesSource({
      settings: liveSettings,
      period: "5m",
      hasTushareToken: hasToken,
    });
    if (daily === "tushare_daily") {
      return {
        status: "healthy",
        message: `qubit-data: 日线 → Tushare（已配置 token）；日内 → ${intraday}`,
      };
    }
    if (daily === "eastmoney") {
      return {
        status: "healthy",
        message: "qubit-data: A 股日线 / 分钟小时 K → 东方财富（免费，无需 API key）",
      };
    }
    if (daily === "akshare") {
      return {
        status: "healthy",
        message:
          "qubit-data: A 股 K 线 → AKShare（Python，需 pip install akshare pandas；失败时 A 股回退东方财富）",
      };
    }
    if (daily === "yahoo_chart") {
      return {
        status: "healthy",
        message: "qubit-data: 日线 / 分钟小时 K → Yahoo Finance Chart（免费，无需 API key）",
      };
    }
    return {
      status: "healthy",
      message: "qubit-data: 当前配置下日线无外源（K 线将为空，见服务端 fetch_bars 日志）",
    };
  }

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    if (operation === "write_snapshot") {
      const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
      return {
        ok: true,
        note: "snapshot accepted (native; persist in write_snapshot when you add storage)",
        keys: Object.keys(p),
      } as TOutput;
    }
    if (operation === "fetch_klines") {
      const raw = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
      const p = raw as {
        symbol?: string;
        exchange?: string;
        timeframe?: string;
        limit?: number;
      };
      const symbol = String(p.symbol ?? "").trim();
      if (!symbol) throw new Error("fetch_klines: symbol is required");
      const exchange = String(p.exchange ?? "");
      const timeframe = String(p.timeframe ?? "1d");
      const limit = Math.max(1, Math.min(Number(p.limit ?? 120), 2000));
      const { startDate, endDate, period } = computeDateRangeForLimit(timeframe, limit);
      return this.fetchBars({
        symbol,
        exchange,
        period,
        startDate,
        endDate,
      }) as TOutput;
    }
    return super.onExecute<TOutput>(operation, payload);
  }

  private logFetchBarsEmpty(reason: string, detail?: unknown): void {
    if (detail !== undefined) {
      console.warn(`[qubit-data] fetch_bars: empty — ${reason}`, detail);
    } else {
      console.warn(`[qubit-data] fetch_bars: empty — ${reason}`);
    }
  }

  async fetchBars(params: FetchBarsParams): Promise<BarData[]> {
    if (!params.symbol?.trim()) throw new Error("fetch_bars: symbol is required");
    const start = Date.parse(params.startDate);
    const end = Date.parse(params.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error("fetch_bars: startDate/endDate must be parseable dates");
    }

    const liveSettings = await loadBuiltinConnectorSettings();
    const tokenLive = tushareTokenFromSettings(liveSettings, this.tushareToken);
    const hasTushare = Boolean(tokenLive);
    const dataCfg = (liveSettings["qubit-data"] ?? {}) as Record<string, unknown>;
    const klinesRaw =
      typeof dataCfg.klinesDataSource === "string" ? dataCfg.klinesDataSource : undefined;

    const mode = parseKlinesDataSourceSetting(klinesRaw);
    const effective = resolveEffectiveKlinesSource({
      settings: liveSettings,
      period: params.period,
      hasTushareToken: hasTushare,
      symbol: params.symbol,
      exchange: params.exchange,
    });

    if (effective === "tushare_daily" && tokenLive) {
      try {
        const tsCode = symbolToTsCode(params.symbol, params.exchange || "");
        const data = await tushareCall(tokenLive, "daily", {
          ts_code: tsCode,
          start_date: parseIsoToYmd(params.startDate),
          end_date: parseIsoToYmd(params.endDate),
        });
        const fields = data.fields ?? [];
        const items = data.items ?? [];
        const iTrade = idx(fields, "trade_date");
        const iOpen = idx(fields, "open");
        const iHigh = idx(fields, "high");
        const iLow = idx(fields, "low");
        const iClose = idx(fields, "close");
        const iVol = idx(fields, "vol");
        const iAmount = idx(fields, "amount");
        if (iTrade < 0 || iOpen < 0 || iHigh < 0 || iLow < 0 || iClose < 0) {
          this.logFetchBarsEmpty(
            `Tushare daily response missing required fields (ts_code=${tsCode}, fields=${fields.join(",")})`
          );
          return [];
        }
        const bars: BarData[] = [];
        for (const row of items) {
          const tradeRaw = row[iTrade];
          const tradeDate =
            typeof tradeRaw === "string"
              ? tradeRaw.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")
              : String(tradeRaw ?? "");
          const ts =
            tradeDate.length >= 10
              ? new Date(`${tradeDate.slice(0, 10)}T00:00:00Z`).toISOString()
              : new Date().toISOString();
          const num = (j: number) => Number(row[j] ?? 0);
          bars.push({
            symbol: params.symbol,
            exchange: params.exchange || "UNKNOWN",
            open: num(iOpen),
            high: num(iHigh),
            low: num(iLow),
            close: num(iClose),
            volume: num(iVol),
            turnover: iAmount >= 0 ? num(iAmount) : 0,
            timestamp: ts,
          });
        }
        bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        if (bars.length === 0) {
          this.logFetchBarsEmpty(
            `Tushare daily returned no rows (ts_code=${tsCode}, start=${parseIsoToYmd(params.startDate)}, end=${parseIsoToYmd(params.endDate)})`
          );
        }
        return bars;
      } catch (e) {
        this.logFetchBarsEmpty(
          `Tushare daily request failed (symbol=${params.symbol}, exchange=${params.exchange ?? ""})`,
          e instanceof Error ? e.message : e
        );
        return [];
      }
    }

    if (effective === "akshare") {
      try {
        const bars = await fetchAkshareBars(params);
        if (bars.length > 0) return bars;
        this.logFetchBarsEmpty(
          `AKShare returned no usable OHLCV (symbol=${params.symbol}, period=${params.period}, window=${params.startDate}…${params.endDate})`
        );
      } catch (e) {
        this.logFetchBarsEmpty(
          `AKShare request failed (symbol=${params.symbol}, exchange=${params.exchange ?? ""})`,
          e instanceof Error ? e.message : e
        );
      }
      if (isChinaAShareMarket(params.symbol, params.exchange || "")) {
        try {
          const fallback = await fetchEastMoneyBars(params);
          if (fallback.length > 0) {
            console.warn(
              `[qubit-data] AKShare unavailable or empty; fell back to East Money for ${params.symbol}`
            );
            return fallback;
          }
        } catch {
          /* logged below if still empty */
        }
      }
      if (mode === "akshare") return [];
    }

    if (effective === "eastmoney") {
      try {
        const bars = await fetchEastMoneyBars(params);
        if (bars.length > 0) return bars;
        this.logFetchBarsEmpty(
          `East Money returned no usable OHLCV (symbol=${params.symbol}, period=${params.period}, window=${params.startDate}…${params.endDate})`
        );
        if (mode !== "auto") return [];
      } catch (e) {
        this.logFetchBarsEmpty(
          `East Money request failed (symbol=${params.symbol}, exchange=${params.exchange ?? ""})`,
          e instanceof Error ? e.message : e
        );
        if (mode !== "auto") return [];
      }
    }

    if (effective === "yahoo_chart" || (effective === "eastmoney" && mode === "auto")) {
      try {
        const ySym = symbolToYahooSymbol(params.symbol, params.exchange || "");
        const bars = await fetchYahooFinanceBars(params);
        if (bars.length === 0) {
          this.logFetchBarsEmpty(
            `Yahoo Finance returned no usable OHLCV (yahooSymbol=${ySym}, period=${params.period}, window=${params.startDate}…${params.endDate})`
          );
        }
        return bars;
      } catch (e) {
        this.logFetchBarsEmpty(
          `Yahoo Finance request failed (symbol=${params.symbol}, exchange=${params.exchange ?? ""})`,
          e instanceof Error ? e.message : e
        );
        return [];
      }
    }

    if (effective === "synthetic") {
      if (mode === "tushare_daily" && !tokenLive) {
        this.logFetchBarsEmpty(
          `klinesDataSource=tushare_daily but tushareToken is missing (symbol=${params.symbol})`
        );
      } else if (mode === "synthetic") {
        this.logFetchBarsEmpty(
          `klinesDataSource=synthetic — external K-line disabled by configuration (symbol=${params.symbol})`
        );
      } else {
        this.logFetchBarsEmpty(
          `no upstream for bars (mode=${mode}, effective=${effective}, period=${params.period}, symbol=${params.symbol})`
        );
      }
      return [];
    }

    this.logFetchBarsEmpty(
      `unexpected resolution (effective=${effective}, symbol=${params.symbol}, period=${params.period})`
    );
    return [];
  }

  async fetchTicks(params: FetchTicksParams): Promise<TickData[]> {
    if (!params.symbol?.trim()) throw new Error("fetch_ticks: symbol is required");
    return [
      {
        symbol: params.symbol,
        exchange: params.exchange || "UNKNOWN",
        lastPrice: 100,
        bidPrice: 99.9,
        askPrice: 100.1,
        bidVolume: 100,
        askVolume: 100,
        volume: 1_000_000,
        timestamp: new Date(`${params.date}T09:30:00Z`).toISOString(),
      },
    ];
  }

  async fetchNews(_params: FetchNewsParams): Promise<NewsData[]> {
    return [];
  }

  async fetchFundamentals(params: FetchFundamentalsParams): Promise<FundamentalData> {
    return {
      symbol: params.symbol,
      exchange: params.exchange || "UNKNOWN",
      periods: [],
    };
  }
}
