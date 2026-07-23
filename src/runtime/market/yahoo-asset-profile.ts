import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import { symbolToYahooSymbol } from "./klines-data-source";
import { marketDataFetch } from "./market-data-network";

const UA = "Mozilla/5.0 (compatible; QubitAgent/1.0; +https://github.com/)";

export interface YahooAssetLabels {
  sector: string | null;
  industry: string | null;
  aliases: string[];
}

/** Best-effort sector / industry from Yahoo `quoteSummary` (assetProfile). */
export async function fetchYahooAssetLabels(
  symbol: string,
  exchange: string,
  settings: BuiltinConnectorInitConfigs = {}
): Promise<YahooAssetLabels | null> {
  const ticker = symbolToYahooSymbol(symbol, exchange);
  if (!ticker) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const quoteSummaryUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=assetProfile`;
    const summaryRes = await marketDataFetch(
      "yahoo_chart",
      settings,
      quoteSummaryUrl,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal },
      12_000
    );
    if (summaryRes.ok) {
      const json = (await summaryRes.json()) as {
        quoteSummary?: {
          result?: Array<{
            assetProfile?: { sector?: string; industry?: string };
            price?: { shortName?: string; longName?: string };
          }>;
        };
      };
      const result = json.quoteSummary?.result?.[0];
      const ap = result?.assetProfile;
      const aliases = [result?.price?.shortName, result?.price?.longName]
        .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        .map((value) => value.trim());
      const sector = typeof ap?.sector === "string" && ap.sector.trim() ? ap.sector.trim() : null;
      const industry =
        typeof ap?.industry === "string" && ap.industry.trim() ? ap.industry.trim() : null;
      if (sector || industry || aliases.length > 0) {
        return { sector, industry, aliases: Array.from(new Set(aliases)) };
      }
    }

    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`;
    const chartRes = await marketDataFetch(
      "yahoo_chart",
      settings,
      chartUrl,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal },
      12_000
    );
    if (!chartRes.ok) return null;
    const chart = (await chartRes.json()) as {
      chart?: { result?: Array<{ meta?: { shortName?: string; longName?: string } }> };
    };
    const meta = chart.chart?.result?.[0]?.meta;
    const aliases = [meta?.shortName, meta?.longName]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .map((value) => value.trim());
    return aliases.length > 0
      ? { sector: null, industry: null, aliases: Array.from(new Set(aliases)) }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
