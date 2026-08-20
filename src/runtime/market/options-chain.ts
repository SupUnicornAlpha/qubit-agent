import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import { fetchFutuOptionChain } from "./futu-klines";
import { marketDataFetch } from "./market-data-network";
import { fetchYfinanceOptionChain } from "./yfinance-klines";

export type OptionChainSource = "futu_opend" | "alpaca" | "yahoo_chart" | "yfinance";
export type OptionChainRequestSource = "auto" | "futu" | "alpaca" | "research";

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
  /** Only populated by a broker source that supplies the values directly. */
  greeks?: {
    delta: number | null;
    gamma: number | null;
    vega: number | null;
    theta: number | null;
    rho: number | null;
  };
};

export type OptionChain = {
  underlying: string;
  source: OptionChainSource;
  /** Feed tier / permitted use, surfaced so a public fallback is never mistaken for a broker feed. */
  feedClass: "L0_research_fallback" | "L2_realtime_observe";
  licenseUse: "research_only" | "observe_only";
  /** True only when auto mode failed over from an explicit broker-first request. */
  fallbackUsed: boolean;
  fallbackReason?: string;
  fetchedAt: string;
  expirations: string[];
  calls: OptionContract[];
  puts: OptionContract[];
};

function withResearchMetadata(
  chain: Omit<OptionChain, "feedClass" | "licenseUse" | "fallbackUsed" | "fallbackReason">,
  fallbackReason?: string
): OptionChain {
  return {
    ...chain,
    feedClass: "L0_research_fallback",
    licenseUse: "research_only",
    fallbackUsed: Boolean(fallbackReason),
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

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
 * Broker-first option-chain policy.
 *
 * `auto` attempts configured broker sources (Futu, then Alpaca) before the
 * research-grade Yahoo path. Explicit broker modes are strict, so a missing
 * entitlement is never silently represented as broker data.
 */
export async function fetchOptionChain(input: {
  symbol: string;
  exchange?: string;
  expiry?: string;
  source?: OptionChainRequestSource;
  settings: BuiltinConnectorInitConfigs;
}): Promise<OptionChain> {
  const source = input.source ?? "auto";
  if (source === "research") {
    return fetchYahooOptionChain(input);
  }

  const errors: string[] = [];
  if (source === "auto" || source === "futu") {
    try {
      return await fetchFutuOptionChain({
        symbol: input.symbol,
        exchange: input.exchange ?? "US",
        ...(input.expiry?.trim() ? { expiry: input.expiry } : {}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (source === "futu") throw new Error(`futu_option_chain_unavailable: ${reason}`);
      errors.push(`Futu OpenD unavailable: ${reason}`);
    }
  }
  if (source === "auto" || source === "alpaca") {
    try {
      return await fetchAlpacaOptionChain(input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (source === "alpaca") throw new Error(`alpaca_option_chain_unavailable: ${reason}`);
      errors.push(`Alpaca unavailable: ${reason}`);
    }
  }
  const research = await fetchYahooOptionChain(input);
  return {
    ...research,
    fallbackUsed: true,
    fallbackReason: errors.join("; "),
  };
}

/** Alpaca option snapshots include latest trade/quote and broker-supplied Greeks. */
export async function fetchAlpacaOptionChain(input: {
  symbol: string;
  expiry?: string;
}): Promise<OptionChain> {
  const key = process.env.QUBIT_ALPACA_API_KEY_ID ?? process.env.ALPACA_API_KEY_ID ?? "";
  const secret = process.env.QUBIT_ALPACA_API_SECRET ?? process.env.ALPACA_API_SECRET ?? "";
  if (!key || !secret) throw new Error("Alpaca API credentials missing");
  const underlying = normalizeUnderlying(input.symbol);
  const url = new URL(`https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(underlying)}`);
  url.searchParams.set("feed", process.env.QUBIT_ALPACA_OPTIONS_FEED ?? "indicative");
  url.searchParams.set("limit", "1000");
  if (input.expiry?.trim()) url.searchParams.set("expiration_date", input.expiry.slice(0, 10));
  const response = await fetch(url, {
    headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret, Accept: "application/json" },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Alpaca HTTP ${response.status}: ${text.slice(0, 180)}`);
  const payload = JSON.parse(text) as { snapshots?: Record<string, Record<string, unknown>> };
  const calls: OptionContract[] = [], puts: OptionContract[] = [];
  const expirations = new Set<string>();
  for (const [contractSymbol, snapshot] of Object.entries(payload.snapshots ?? {})) {
    const parsed = alpacaContract(snapshot, contractSymbol);
    if (!parsed) continue;
    if (parsed.expiration) expirations.add(parsed.expiration);
    (parsed.right === "call" ? calls : puts).push(parsed);
  }
  return {
    underlying, source: "alpaca", feedClass: "L2_realtime_observe", licenseUse: "observe_only",
    fallbackUsed: false, fetchedAt: new Date().toISOString(), expirations: [...expirations].sort(), calls, puts,
  };
}

function alpacaContract(snapshot: Record<string, unknown>, contractSymbol: string): OptionContract | null {
  const match = contractSymbol.match(/(\d{6})([CP])(\d{8})$/);
  if (!match) return null;
  const quote = (snapshot.latestQuote ?? snapshot.latest_quote ?? {}) as Record<string, unknown>;
  const trade = (snapshot.latestTrade ?? snapshot.latest_trade ?? {}) as Record<string, unknown>;
  const greeks = (snapshot.greeks ?? {}) as Record<string, unknown>;
  const expiry = `20${match[1]!.slice(0, 2)}-${match[1]!.slice(2, 4)}-${match[1]!.slice(4, 6)}`;
  return {
    contractSymbol, right: match[2] === "C" ? "call" : "put", strike: Number(match[3]) / 1000,
    lastPrice: numberOrNull(trade.p), bid: numberOrNull(quote.bp), ask: numberOrNull(quote.ap),
    change: null, percentChange: null, volume: null, openInterest: numberOrNull(snapshot.openInterest ?? snapshot.open_interest),
    impliedVolatility: numberOrNull(snapshot.impliedVolatility ?? snapshot.implied_volatility), inTheMoney: false, expiration: expiry,
    greeks: { delta: numberOrNull(greeks.delta), gamma: numberOrNull(greeks.gamma), vega: numberOrNull(greeks.vega), theta: numberOrNull(greeks.theta), rho: numberOrNull(greeks.rho) },
  };
}

/**
 * Research-grade Yahoo option-chain path. It is deliberately public / fallback
 * only and must not be used for trading, pricing or Greeks inference.
 */
export async function fetchYahooOptionChain(input: {
  symbol: string;
  expiry?: string;
  settings: BuiltinConnectorInitConfigs;
}): Promise<OptionChain> {
  let yfinanceError: unknown;
  try {
    // The Python connector is persistent, so yfinance can retain / refresh the
    // Yahoo cookie+crumb pair. Use it first; the stateless public endpoint is
    // retained only as a dependency-free fallback.
    return withResearchMetadata(await fetchYfinanceOptionChain(input));
  } catch (error) {
    yfinanceError = error;
  }

  try {
    return await fetchYahooOptionChainDirect(input);
  } catch (directError) {
    const yfinanceReason = yfinanceError instanceof Error ? yfinanceError.message : String(yfinanceError);
    const directReason = directError instanceof Error ? directError.message : String(directError);
    throw new Error(`options_chain unavailable (yfinance: ${yfinanceReason}; Yahoo fallback: ${directReason})`);
  }
}

async function fetchYahooOptionChainDirect(input: {
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
  return withResearchMetadata({
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
  });
}
