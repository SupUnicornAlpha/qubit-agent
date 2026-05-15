import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { brokerAccount } from "../../db/sqlite/schema";
import type { BrokerProvider, CcxtProviderConfig, FutuProviderConfig } from "../reia/broker-types";
import { getTradingSession, type MarketCode, type TradingSessionConfig } from "./trading-calendar";

export interface ResolvedInstrument {
  market: MarketCode;
  symbol: string;
  normalizedSymbol: string;
  brokerProvider: BrokerProvider;
  brokerAccountId: string | null;
  sessionCalendar: TradingSessionConfig;
}

const MARKET_DEFAULT_PROVIDER: Record<MarketCode, BrokerProvider> = {
  HK: "futu",
  US: "ib",
  CN: "futu",
  CRYPTO: "ccxt",
};

function normalizeSymbol(market: MarketCode, symbol: string): string {
  const s = symbol.trim();
  if (market === "HK" && !s.includes(".")) return `HK.${s.replace(/^0+/, "").padStart(5, "0")}`;
  return s;
}

async function pickDefaultBrokerAccount(provider: BrokerProvider, market?: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(brokerAccount)
    .where(and(eq(brokerAccount.provider, provider), eq(brokerAccount.enabled, true)))
    .orderBy(desc(brokerAccount.isDefault), desc(brokerAccount.updatedAt));

  if (!rows.length) return null;

  if (market) {
    const matched = rows.find((r) => {
      const cfg = (r.providerConfigJson ?? {}) as FutuProviderConfig | CcxtProviderConfig;
      if ("market" in cfg && cfg.market) return String(cfg.market).toUpperCase() === market.toUpperCase();
      return false;
    });
    if (matched) return matched.id;
  }

  const defaulted = rows.find((r) => r.isDefault);
  return (defaulted ?? rows[0])?.id ?? null;
}

export async function resolveInstrument(input: {
  market: string;
  symbol: string;
  brokerAccountId?: string | null;
  brokerProvider?: BrokerProvider;
}): Promise<ResolvedInstrument> {
  const marketKey = input.market.toUpperCase() as MarketCode;
  const market: MarketCode =
    marketKey === "HK" || marketKey === "US" || marketKey === "CN" || marketKey === "CRYPTO"
      ? marketKey
      : "US";

  const brokerProvider = input.brokerProvider ?? MARKET_DEFAULT_PROVIDER[market];
  const normalizedSymbol = normalizeSymbol(market, input.symbol);

  let brokerAccountId = input.brokerAccountId ?? null;
  if (!brokerAccountId) {
    brokerAccountId = await pickDefaultBrokerAccount(brokerProvider, market);
  }

  return {
    market,
    symbol: input.symbol.trim(),
    normalizedSymbol,
    brokerProvider,
    brokerAccountId,
    sessionCalendar: getTradingSession(market),
  };
}
