import { symbolToYahooSymbol } from "./klines-data-source";

const UA = "Mozilla/5.0 (compatible; QubitAgent/1.0; +https://github.com/)";

export interface YahooAssetLabels {
  sector: string | null;
  industry: string | null;
}

/** Best-effort sector / industry from Yahoo `quoteSummary` (assetProfile). */
export async function fetchYahooAssetLabels(symbol: string, exchange: string): Promise<YahooAssetLabels | null> {
  const ticker = symbolToYahooSymbol(symbol, exchange);
  if (!ticker) return null;
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=assetProfile`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      quoteSummary?: { result?: Array<{ assetProfile?: { sector?: string; industry?: string } }> };
    };
    const ap = json.quoteSummary?.result?.[0]?.assetProfile;
    if (!ap) return null;
    const sector = typeof ap.sector === "string" && ap.sector.trim() ? ap.sector.trim() : null;
    const industry = typeof ap.industry === "string" && ap.industry.trim() ? ap.industry.trim() : null;
    if (!sector && !industry) return null;
    return { sector, industry };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
