import type { NewsData } from "../../connectors/data/data.connector";
import { registerBuiltinConnectors } from "../../connectors/bootstrap";
import { connectorRegistry } from "../../connectors/registry";
import { fetchYahooHeadlineRss, type RssHeadlineItem } from "./rss-headlines";
import { symbolToYahooSymbol } from "./klines-data-source";
import { sectorToHeadlineTicker } from "./sector-etf-map";
import { fetchYahooAssetLabels } from "./yahoo-asset-profile";

export interface MarketNewsBriefItem {
  id: string;
  title: string;
  content: string;
  publishedAt: string;
  source: string;
  url?: string;
}

function newsDataToBrief(n: NewsData): MarketNewsBriefItem {
  return {
    id: n.id,
    title: n.title,
    content: n.content,
    publishedAt: n.publishedAt,
    source: n.source,
  };
}

function rssToBrief(r: RssHeadlineItem): MarketNewsBriefItem {
  return {
    id: r.id,
    title: r.title,
    content: "",
    publishedAt: r.publishedAt,
    source: r.source,
    url: r.link,
  };
}

function dedupeByTitle(items: MarketNewsBriefItem[]): MarketNewsBriefItem[] {
  const seen = new Set<string>();
  const out: MarketNewsBriefItem[] = [];
  for (const it of items) {
    const k = it.title.trim().toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

async function fetchConnectorNews(partial: {
  symbols?: string[];
  keywords?: string[];
  limit: number;
}): Promise<NewsData[]> {
  await registerBuiltinConnectors();
  const conn = connectorRegistry.get("qubit-news");
  if (!conn) return [];
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  try {
    return (await conn.execute("fetch_news", {
      symbols: partial.symbols,
      keywords: partial.keywords,
      startDate,
      endDate,
      limit: partial.limit,
    })) as NewsData[];
  } catch {
    return [];
  }
}

export interface MarketNewsBriefResult {
  sectorLabel: string | null;
  sectorHeadlineTicker: string | null;
  symbolNews: MarketNewsBriefItem[];
  sectorNews: MarketNewsBriefItem[];
}

export async function queryMarketNewsBrief(params: {
  symbol: string;
  exchange?: string;
  limit?: number;
}): Promise<MarketNewsBriefResult> {
  const symbol = params.symbol.trim();
  const exchange = (params.exchange ?? "").trim();
  const limit = Math.min(Math.max(params.limit ?? 12, 1), 30);

  if (!symbol) {
    return { sectorLabel: null, sectorHeadlineTicker: null, symbolNews: [], sectorNews: [] };
  }

  const labels = await fetchYahooAssetLabels(symbol, exchange);
  const yTicker = symbolToYahooSymbol(symbol, exchange);
  const sectorTicker = sectorToHeadlineTicker(labels?.sector ?? undefined);
  const sectorKeywords =
    labels?.industry ? [labels.industry] : labels?.sector ? [labels.sector] : [];

  const symConnLimit = Math.min(5, limit);
  const [rssSymbol, rssSector, symConn, secConn] = await Promise.all([
    fetchYahooHeadlineRss(yTicker, limit),
    fetchYahooHeadlineRss(sectorTicker, limit),
    fetchConnectorNews({ symbols: [symbol], limit: symConnLimit }),
    sectorKeywords.length
      ? fetchConnectorNews({ keywords: sectorKeywords, limit: symConnLimit })
      : Promise.resolve([]),
  ]);

  const sectorLabel =
    labels?.industry && labels?.sector
      ? `${labels.industry}（${labels.sector}）`
      : labels?.industry ?? labels?.sector ?? null;

  const symbolNews = dedupeByTitle([...symConn.map(newsDataToBrief), ...rssSymbol.map(rssToBrief)]).slice(0, limit);

  const sectorNews = dedupeByTitle([...secConn.map(newsDataToBrief), ...rssSector.map(rssToBrief)]).slice(0, limit);

  return {
    sectorLabel,
    sectorHeadlineTicker: sectorTicker,
    symbolNews,
    sectorNews,
  };
}
