import { registerBuiltinConnectors } from "../../connectors/bootstrap";
import type { NewsData } from "../../connectors/data/data.connector";
import { connectorRegistry } from "../../connectors/registry";
import { loadBuiltinConnectorSettings } from "../config/builtin-connector-settings";
import { symbolToYahooSymbol } from "./klines-data-source";
import { type NewsEvidenceRejection, assessNewsEvidence } from "./news-evidence";
import { type RssHeadlineItem, fetchYahooHeadlineRss } from "./rss-headlines";
import { sectorToHeadlineTicker } from "./sector-etf-map";
import { fetchYahooAssetLabels } from "./yahoo-asset-profile";

export interface MarketNewsBriefItem {
  id: string;
  title: string;
  content: string;
  publishedAt: string;
  source: string;
  url?: string;
  symbols?: string[];
  isSynthetic?: boolean;
}

function newsDataToBrief(n: NewsData): MarketNewsBriefItem {
  return {
    id: n.id,
    title: n.title,
    content: n.content,
    publishedAt: n.publishedAt,
    source: n.source,
    symbols: n.symbols,
    ...(n.isSynthetic !== undefined ? { isSynthetic: n.isSynthetic } : {}),
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

/** qubit-news `fetch_news` returns `{ items, aggregateSentiment }`, not a bare array. */
function normalizeConnectorNewsResult(raw: unknown): NewsData[] {
  if (Array.isArray(raw)) return raw as NewsData[];
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.items)) return o.items as NewsData[];
    if (Array.isArray(o.data)) return o.data as NewsData[];
    if (Array.isArray(o.news)) return o.news as NewsData[];
  }
  return [];
}

async function fetchConnectorNews(partial: {
  symbols?: string[];
  keywords?: string[];
  limit: number;
  maxAgeDays: number;
}): Promise<NewsData[]> {
  await registerBuiltinConnectors();
  const conn = connectorRegistry.get("qubit-news");
  if (!conn) return [];
  const end = new Date();
  const start = new Date(end.getTime() - partial.maxAgeDays * 24 * 60 * 60 * 1000);
  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  try {
    const raw = await conn.execute("fetch_news", {
      symbols: partial.symbols,
      keywords: partial.keywords,
      startDate,
      endDate,
      limit: partial.limit,
    });
    return normalizeConnectorNewsResult(raw);
  } catch {
    return [];
  }
}

export interface MarketNewsBriefResult {
  sectorLabel: string | null;
  sectorHeadlineTicker: string | null;
  symbolNews: MarketNewsBriefItem[];
  sectorNews: MarketNewsBriefItem[];
  evidence: {
    mode: "current" | "historical_validation";
    maxAgeDays: number;
    status: "ready" | "partial" | "unavailable";
    latestPublishedAt: string | null;
    rejected: Record<NewsEvidenceRejection, number>;
  };
}

export async function queryMarketNewsBrief(params: {
  symbol: string;
  exchange?: string;
  limit?: number;
  mode?: "current" | "historical_validation";
  maxAgeDays?: number;
  aliases?: string[];
  asOf?: Date;
}): Promise<MarketNewsBriefResult> {
  const symbol = params.symbol.trim();
  const exchange = (params.exchange ?? "").trim();
  const limit = Math.min(Math.max(params.limit ?? 12, 1), 30);
  const mode = params.mode ?? "current";
  const maxAgeDays = Math.max(1, params.maxAgeDays ?? (mode === "current" ? 7 : 365));

  if (!symbol) {
    return {
      sectorLabel: null,
      sectorHeadlineTicker: null,
      symbolNews: [],
      sectorNews: [],
      evidence: {
        mode,
        maxAgeDays,
        status: "unavailable",
        latestPublishedAt: null,
        rejected: { synthetic: 0, missing_or_invalid_time: 0, stale: 0, irrelevant: 0 },
      },
    };
  }

  const settings = await loadBuiltinConnectorSettings();
  const labels = await fetchYahooAssetLabels(symbol, exchange, settings);
  const yTicker = symbolToYahooSymbol(symbol, exchange);
  const sectorTicker = sectorToHeadlineTicker(labels?.sector ?? undefined);
  const sectorKeywords = labels?.industry
    ? [labels.industry]
    : labels?.sector
      ? [labels.sector]
      : [];

  const symConnLimit = Math.min(5, limit);
  const [rssSymbol, rssSector, symConn, secConn] = await Promise.all([
    fetchYahooHeadlineRss(yTicker, limit, settings),
    fetchYahooHeadlineRss(sectorTicker, limit, settings),
    fetchConnectorNews({ symbols: [symbol], limit: symConnLimit, maxAgeDays }),
    sectorKeywords.length
      ? fetchConnectorNews({ keywords: sectorKeywords, limit: symConnLimit, maxAgeDays })
      : Promise.resolve([]),
  ]);

  const sectorLabel =
    labels?.industry && labels?.sector
      ? `${labels.industry}（${labels.sector}）`
      : (labels?.industry ?? labels?.sector ?? null);

  const symbolAssessment = assessNewsEvidence(
    dedupeByTitle([...symConn.map(newsDataToBrief), ...rssSymbol.map(rssToBrief)]),
    {
      symbol,
      aliases: [yTicker, ...(labels?.aliases ?? []), ...(params.aliases ?? [])],
      ...(params.asOf ? { asOf: params.asOf } : {}),
      maxAgeDays,
      allowHistorical: mode === "historical_validation",
    }
  );
  const symbolNews = symbolAssessment.accepted.slice(0, limit);

  const sectorAssessment = assessNewsEvidence(
    dedupeByTitle([...secConn.map(newsDataToBrief), ...rssSector.map(rssToBrief)]),
    {
      symbol: sectorTicker,
      aliases: sectorKeywords,
      ...(params.asOf ? { asOf: params.asOf } : {}),
      maxAgeDays,
      requireSymbolRelevance: false,
      allowHistorical: mode === "historical_validation",
    }
  );
  const sectorNews = sectorAssessment.accepted.slice(0, limit);
  const latestPublishedAt =
    [symbolAssessment.latestPublishedAt, sectorAssessment.latestPublishedAt]
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
  const rejected = Object.fromEntries(
    (Object.keys(symbolAssessment.rejected) as NewsEvidenceRejection[]).map((key) => [
      key,
      symbolAssessment.rejected[key] + sectorAssessment.rejected[key],
    ])
  ) as Record<NewsEvidenceRejection, number>;
  const status =
    symbolNews.length > 0 ? "ready" : sectorNews.length > 0 ? "partial" : "unavailable";

  return {
    sectorLabel,
    sectorHeadlineTicker: sectorTicker,
    symbolNews,
    sectorNews,
    evidence: { mode, maxAgeDays, status, latestPublishedAt, rejected },
  };
}
