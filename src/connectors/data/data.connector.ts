import type { ConnectorConfig, ConnectorMeta, HealthCheckResult } from "../../types/connector";
import { BaseConnector } from "../base.connector";

/**
 * DataConnector — abstract base for market/news/fundamental/event data sources.
 *
 * Concrete implementations: TushareConnector, AKShareConnector, BaoStockConnector, etc.
 *
 * The four `abstract` methods (bars/ticks/news/fundamentals) are required;
 * the optional methods (`fetchDividends`/`fetchEarnings`/`fetchAssetInfo`)
 * default to throwing `not_supported` so existing subclasses keep compiling
 * while new sources (e.g. yfinance) can opt-in by overriding them.
 */
export abstract class DataConnector extends BaseConnector {
  abstract readonly meta: ConnectorMeta;

  // ─── Data-specific operations ──────────────────────────────────────────────

  abstract fetchBars(params: FetchBarsParams): Promise<BarData[]>;
  abstract fetchTicks(params: FetchTicksParams): Promise<TickData[]>;
  abstract fetchNews(params: FetchNewsParams): Promise<NewsData[]>;
  abstract fetchFundamentals(params: FetchFundamentalsParams): Promise<FundamentalData>;

  /** Optional — yfinance-class sources only; default rejects with `not_supported`. */
  async fetchDividends(_params: FetchDividendsParams): Promise<DividendItem[]> {
    throw new Error("fetch_dividends: not supported by this connector");
  }

  /** Optional — yfinance-class sources only; default rejects with `not_supported`. */
  async fetchEarnings(_params: FetchEarningsParams): Promise<EarningsItem[]> {
    throw new Error("fetch_earnings: not supported by this connector");
  }

  /** Optional — yfinance-class sources only; default rejects with `not_supported`. */
  async fetchAssetInfo(_params: FetchAssetInfoParams): Promise<AssetInfoData> {
    throw new Error("fetch_asset_info: not supported by this connector");
  }

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    switch (operation) {
      case "fetch_bars":
        return this.fetchBars(payload as FetchBarsParams) as unknown as TOutput;
      case "fetch_ticks":
        return this.fetchTicks(payload as FetchTicksParams) as unknown as TOutput;
      case "fetch_news":
        return this.fetchNews(payload as FetchNewsParams) as unknown as TOutput;
      case "fetch_fundamentals":
        return this.fetchFundamentals(payload as FetchFundamentalsParams) as unknown as TOutput;
      case "fetch_dividends":
        return this.fetchDividends(payload as FetchDividendsParams) as unknown as TOutput;
      case "fetch_earnings":
        return this.fetchEarnings(payload as FetchEarningsParams) as unknown as TOutput;
      case "fetch_asset_info":
        return this.fetchAssetInfo(payload as FetchAssetInfoParams) as unknown as TOutput;
      default:
        throw new Error(`DataConnector: unknown operation "${operation}"`);
    }
  }
}

// ─── Parameter / result types ─────────────────────────────────────────────────

export interface FetchBarsParams {
  symbol: string;
  exchange: string;
  period: "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
  startDate: string;
  endDate: string;
  adjustType?: "none" | "pre" | "post";
}

export interface BarData {
  symbol: string;
  exchange: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
  timestamp: string;
}

export interface FetchTicksParams {
  symbol: string;
  exchange: string;
  date: string;
}

export interface TickData {
  symbol: string;
  exchange: string;
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  bidVolume: number;
  askVolume: number;
  volume: number;
  timestamp: string;
}

export interface FetchNewsParams {
  keywords?: string[];
  symbols?: string[];
  startDate: string;
  endDate: string;
  limit?: number;
}

export interface NewsData {
  id: string;
  title: string;
  content: string;
  publishedAt: string;
  source: string;
  symbols: string[];
  sentimentScore?: number;
}

export interface FetchFundamentalsParams {
  symbol: string;
  exchange: string;
  reportType: "annual" | "quarterly";
  periods?: number;
}

export interface FundamentalData {
  symbol: string;
  exchange: string;
  periods: Array<{
    periodEnd: string;
    revenue?: number;
    netIncome?: number;
    eps?: number;
    pe?: number;
    pb?: number;
    [key: string]: unknown;
  }>;
}

// ─── Optional yfinance-class operations ───────────────────────────────────────

export interface FetchDividendsParams {
  symbol: string;
  exchange?: string;
  startDate?: string;
  endDate?: string;
}

export interface DividendItem {
  date: string;
  amount: number;
}

export interface FetchEarningsParams {
  symbol: string;
  exchange?: string;
}

export interface EarningsItem {
  period: string;
  source: string;
  revenue?: number | null;
  netIncome?: number | null;
  operatingIncome?: number | null;
  eps?: number | null;
}

export interface FetchAssetInfoParams {
  symbol: string;
  exchange?: string;
}

/**
 * 与 `yfinance-klines.ts:YfinanceAssetInfo` 字段保持一致。
 * 不包含 PII（address/email/phone），由 Python 层白名单过滤。
 */
export interface AssetInfoData {
  symbol: string;
  yahooSymbol?: string;
  shortName?: string;
  longName?: string;
  sector?: string;
  industry?: string;
  country?: string;
  currency?: string;
  marketCap?: number;
  sharesOutstanding?: number;
  beta?: number;
  trailingPE?: number;
  dividendYield?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  longBusinessSummary?: string;
  exchange?: string;
  quoteType?: string;
}
