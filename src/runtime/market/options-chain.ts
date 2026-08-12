import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import { marketDataFetch } from "./market-data-network";

export type OptionContract = {
  contractSymbol: string;
  right: "call" | "put";
  strike: number;
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  change: number | null;
  percentChange: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  inTheMoney: boolean;
  expiration: string | null;
};

export type OptionChain = {
  underlying: string;
  source: "yahoo_chart";
  fetchedAt: string;
  expirations: string[];
  calls: OptionContract[];
  puts: OptionContract[];
};

type YahooOptionContract = {
  contractSymbol?: string;
  strike?: number;
  lastPrice?: number;
  bid?: number;
  ask?: number;
  change?: number;
  percentChange?: number;
  volume?: number;
  openInterest?: number;
  impliedVolatility?: number;
  inTheMoney?: boolean;
  expiration?: number;
};

type YahooOptionPayload = {
  optionChain?: {
    error?: { description?: string };
    result?: Array<{
      expirationDates?: number[];
      options?: Array<{ calls?: YahooOptionContract[]; puts?: YahooOptionContract[] }>;
    }>;
  };
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeUnderlying(raw: string): string {
  const symbol = raw.trim().toUpperCase();
  const compactOcc = symbol.match(/^([A-Z]{1,6})\d{6}[CP]\d{8}$/);
  return compactOcc?.[1] ?? symbol;
}

function toContract(row: YahooOptionContract, right: "call" | "put"): OptionContract | null {
  const strike = numberOrNull(row.strike);
  const contractSymbol =
    typeof row.contractSymbol === "string" ? row.contractSymbol.trim().toUpperCase() : "";
  if (!contractSymbol || strike == null) return null;
  return {
    contractSymbol,
    right,
    strike,
    lastPrice: numberOrNull(row.lastPrice),
    bid: numberOrNull(row.bid),
    ask: numberOrNull(row.ask),
    change: numberOrNull(row.change),
    percentChange: numberOrNull(row.percentChange),
    volume: numberOrNull(row.volume),
    openInterest: numberOrNull(row.openInterest),
    impliedVolatility: numberOrNull(row.impliedVolatility),
    inTheMoney: row.inTheMoney === true,
    expiration:
      typeof row.expiration === "number" ? new Date(row.expiration * 1000).toISOString() : null,
  };
}

/**
 * 查询美股上市期权链。只返回可追溯的原始报价字段，绝不从缺失字段推导 Greeks。
 * Yahoo 是研究级公开 fallback，不能当作实盘报价或交易准入数据。
 */
export async function fetchYahooOptionChain(input: {
  symbol: string;
  expiry?: string;
  settings: BuiltinConnectorInitConfigs;
}): Promise<OptionChain> {
  const underlying = normalizeUnderlying(input.symbol);
  if (!underlying) throw new Error("options_chain: underlying symbol is required");
  const url = new URL(
    `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(underlying)}`
  );
  if (input.expiry?.trim()) {
    const expiryMs = Date.parse(input.expiry);
    if (!Number.isFinite(expiryMs))
      throw new Error("options_chain: expiry must be an ISO date/time");
    url.searchParams.set("date", String(Math.floor(expiryMs / 1000)));
  }
  const response = await marketDataFetch("yahoo_chart", input.settings, url, {
    headers: { Accept: "application/json", "User-Agent": "QubitAgent/1.0" },
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`options_chain: Yahoo HTTP ${response.status}: ${text.slice(0, 180)}`);
  let payload: YahooOptionPayload;
  try {
    payload = JSON.parse(text) as YahooOptionPayload;
  } catch {
    throw new Error("options_chain: Yahoo returned invalid JSON");
  }
  const error = payload.optionChain?.error?.description;
  if (error) throw new Error(`options_chain: ${error}`);
  const result = payload.optionChain?.result?.[0];
  if (!result) throw new Error(`options_chain: no chain available for ${underlying}`);
  const options = result.options?.[0] ?? {};
  const expirations = (result.expirationDates ?? []).map((epoch) =>
    new Date(epoch * 1000).toISOString()
  );
  return {
    underlying,
    source: "yahoo_chart",
    fetchedAt: new Date().toISOString(),
    expirations,
    calls: (options.calls ?? [])
      .map((row) => toContract(row, "call"))
      .filter((row): row is OptionContract => row !== null),
    puts: (options.puts ?? [])
      .map((row) => toContract(row, "put"))
      .filter((row): row is OptionContract => row !== null),
  };
}
