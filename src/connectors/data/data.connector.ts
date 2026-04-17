import type { ConnectorConfig, ConnectorMeta, HealthCheckResult } from "../../types/connector";
import { BaseConnector } from "../base.connector";

/**
 * DataConnector — abstract base for market/news/fundamental/event data sources.
 *
 * Concrete implementations: TushareConnector, AKShareConnector, BaoStockConnector, etc.
 */
export abstract class DataConnector extends BaseConnector {
  abstract readonly meta: ConnectorMeta;

  // ─── Data-specific operations ──────────────────────────────────────────────

  abstract fetchBars(params: FetchBarsParams): Promise<BarData[]>;
  abstract fetchTicks(params: FetchTicksParams): Promise<TickData[]>;
  abstract fetchNews(params: FetchNewsParams): Promise<NewsData[]>;
  abstract fetchFundamentals(params: FetchFundamentalsParams): Promise<FundamentalData>;

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
