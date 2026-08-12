/**
 * Built-in public news feeds (Yahoo Finance + Google News RSS).
 * Used by qubit-news when no custom newsApiBaseUrl is configured, and as
 * a merge source when the API returns empty.
 */

import {
  decodeBoundedText,
  extractHtmlTitle,
  parsePublicHttpUrl,
  stripHtmlToText,
} from "../tools/web-ssrf";
import {
  type RssHeadlineItem,
  fetchYahooHeadlineRss,
  parseRssHeadlineItems,
} from "./rss-headlines";

const UA = "Mozilla/5.0 (compatible; QubitAgent/1.0; +https://github.com/)";

export type PublicNewsItem = {
  id: string;
  title: string;
  content: string;
  publishedAt: string;
  source: string;
  url?: string;
  symbols: string[];
};

function rssToNews(item: RssHeadlineItem, symbols: string[]): PublicNewsItem {
  return {
    id: item.id,
    title: item.title,
    content: "",
    publishedAt: normalizePublishedAt(item.publishedAt),
    source: item.source,
    url: item.link,
    symbols,
  };
}

function normalizePublishedAt(raw: string): string {
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  return new Date().toISOString();
}

export async function fetchGoogleNewsRss(input: {
  query: string;
  limit: number;
  lang?: "en" | "zh";
}): Promise<RssHeadlineItem[]> {
  const q = input.query.trim();
  if (!q) return [];
  const lang = input.lang ?? (/[\u4e00-\u9fff]/.test(q) ? "zh" : "en");
  const url =
    lang === "zh"
      ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`
      : `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml,*/*" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssHeadlineItems(xml, Math.min(Math.max(input.limit, 1), 30)).map((item) => ({
      ...item,
      source: "google-news-rss",
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch a short plain-text snippet from an article URL (SSRF-safe). */
export async function fetchArticleSnippet(
  url: string,
  maxChars = 2_500
): Promise<{ ok: boolean; text?: string; title?: string; error?: string }> {
  const parsed = parsePublicHttpUrl(url);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(parsed.url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "qubit-agent/news.enrich" },
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const contentType = response.headers.get("content-type") ?? "";
    const buffer = await response.arrayBuffer();
    let text = decodeBoundedText(buffer);
    const title =
      /html/i.test(contentType) || /^\s*</.test(text) ? extractHtmlTitle(text) : undefined;
    if (/html/i.test(contentType) || /^\s*</.test(text)) {
      text = stripHtmlToText(text);
    }
    return {
      ok: true,
      ...(title ? { title } : {}),
      text: text.slice(0, maxChars),
    };
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError" ? "timeout" : String(error);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Aggregate public feeds for symbols/keywords, optionally enrich top headlines
 * with article body snippets via web fetch.
 */
export async function fetchPublicNewsBundle(input: {
  symbols?: string[];
  keywords?: string[];
  limit?: number;
  enrichBodies?: boolean;
  enrichTopN?: number;
}): Promise<PublicNewsItem[]> {
  const symbols = (input.symbols ?? []).map((s) => s.trim()).filter(Boolean);
  const keywords = (input.keywords ?? []).map((s) => s.trim()).filter(Boolean);
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 30);
  const queries = [...symbols, ...keywords];
  if (queries.length === 0) return [];

  const perQuery = Math.max(3, Math.ceil(limit / Math.max(1, Math.min(queries.length, 3))));
  const settled = await Promise.all(
    queries.slice(0, 4).flatMap((q) => {
      const isTicker = /^[A-Z]{1,5}$|^\d{6}(\.(SH|SZ|BJ))?$/i.test(q);
      const jobs: Array<Promise<PublicNewsItem[]>> = [
        fetchGoogleNewsRss({ query: q, limit: perQuery }).then((rows) =>
          rows.map((r) => rssToNews(r, symbols.length ? symbols : [q]))
        ),
      ];
      if (isTicker) {
        jobs.push(
          fetchYahooHeadlineRss(q, perQuery).then((rows) =>
            rows.map((r) => rssToNews(r, [q.toUpperCase()]))
          )
        );
      }
      return jobs;
    })
  );

  const merged: PublicNewsItem[] = [];
  const seen = new Set<string>();
  for (const batch of settled) {
    for (const item of batch) {
      const key = item.title.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= limit) break;
    }
    if (merged.length >= limit) break;
  }

  if (input.enrichBodies !== false) {
    const topN = Math.min(input.enrichTopN ?? 4, merged.length);
    await Promise.all(
      merged.slice(0, topN).map(async (item, idx) => {
        if (!item.url) return;
        const snippet = await fetchArticleSnippet(item.url, 2_000);
        if (snippet.ok && snippet.text?.trim()) {
          merged[idx] = {
            ...item,
            content: snippet.text.trim(),
            ...(snippet.title && !item.title ? { title: snippet.title } : {}),
          };
        }
      })
    );
  }

  return merged.slice(0, limit);
}
