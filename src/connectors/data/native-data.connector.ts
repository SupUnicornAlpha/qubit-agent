import type { ConnectorConfig, ConnectorMeta, HealthCheckResult } from "../../types/connector";
import {
  DataConnector,
  type BarData,
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

function idx(fields: string[], name: string): number {
  const i = fields.indexOf(name);
  return i;
}

/**
 * Built-in market data connector: uses Tushare HTTP when `tushareToken` is set in connector init
 * (persisted via UI → SQLite); otherwise deterministic synthetic bars.
 */
export class QubitNativeDataConnector extends DataConnector {
  readonly meta: ConnectorMeta = {
    name: "qubit-data",
    version: "0.1.0",
    connectorType: "data",
    capabilities: ["fetch_bars", "fetch_ticks", "fetch_news", "fetch_fundamentals", "write_snapshot"],
    assetClasses: ["stock"],
    latencyProfile: "batch",
    description:
      "Built-in market data: Tushare daily K-line when token configured; otherwise synthetic stub.",
  };

  private tushareToken: string | undefined;
  private syntheticFallback = true;

  protected async onInit(config: ConnectorConfig): Promise<void> {
    this.tushareToken = cfgStr(config, "tushareToken");
    const sf = config["syntheticFallback"];
    if (typeof sf === "boolean") this.syntheticFallback = sf;
    else this.syntheticFallback = cfgStr(config, "syntheticFallback") !== "false";
  }

  protected async onHealthcheck(): Promise<Omit<HealthCheckResult, "latencyMs" | "checkedAt">> {
    if (this.tushareToken) {
      return { status: "healthy", message: "qubit-data: Tushare token configured" };
    }
    return { status: "healthy", message: "qubit-data: synthetic mode (no token in settings)" };
  }

  protected async onShutdown(): Promise<void> {}

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    if (operation === "write_snapshot") {
      const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
      return {
        ok: true,
        note: "snapshot accepted (native; persist in write_snapshot when you add storage)",
        keys: Object.keys(p),
      } as TOutput;
    }
    return super.onExecute<TOutput>(operation, payload);
  }

  private syntheticBars(params: FetchBarsParams): BarData[] {
    const start = Date.parse(params.startDate);
    const end = Date.parse(params.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error("fetch_bars: startDate/endDate must be parseable dates");
    }
    const bars: BarData[] = [];
    const dayMs = 86_400_000;
    for (let t = start, i = 0; t <= end && i < 64; t += dayMs, i += 1) {
      const base = 100 + (i % 7) * 0.5;
      bars.push({
        symbol: params.symbol,
        exchange: params.exchange || "UNKNOWN",
        open: base,
        high: base + 1.2,
        low: base - 0.8,
        close: base + 0.3,
        volume: 1_000_000 + i * 10_000,
        turnover: 0,
        timestamp: new Date(t).toISOString(),
      });
    }
    return bars;
  }

  async fetchBars(params: FetchBarsParams): Promise<BarData[]> {
    if (!params.symbol?.trim()) throw new Error("fetch_bars: symbol is required");
    const start = Date.parse(params.startDate);
    const end = Date.parse(params.endDate);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error("fetch_bars: startDate/endDate must be parseable dates");
    }

    if (this.tushareToken && params.period === "1d") {
      try {
        const tsCode = symbolToTsCode(params.symbol, params.exchange || "");
        const data = await tushareCall(this.tushareToken, "daily", {
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
          throw new Error("Tushare daily: unexpected field set");
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
        return bars;
      } catch (e) {
        if (!this.syntheticFallback) throw e;
        console.warn(
          "[qubit-data] Tushare fetch_bars failed, using synthetic:",
          e instanceof Error ? e.message : e
        );
      }
    } else if (this.tushareToken && params.period !== "1d") {
      console.warn(
        `[qubit-data] period "${params.period}" is not mapped to Tushare in native connector; using synthetic or extend stk_mins/pro_bar.`
      );
    }

    return this.syntheticBars(params);
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
