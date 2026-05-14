/** Yahoo Finance RSS (headline feed) — lightweight parse, no XML dependency. */

const UA = "Mozilla/5.0 (compatible; QubitAgent/1.0; +https://github.com/)";

export interface RssHeadlineItem {
  id: string;
  title: string;
  link: string;
  publishedAt: string;
  source: string;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractCdataOrText(block: string, tag: string): string {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i").exec(block);
  if (cdata?.[1]) return decodeXmlEntities(cdata[1].trim());
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (plain?.[1]) return decodeXmlEntities(plain[1].replace(/<[^>]+>/g, "").trim());
  return "";
}

/** Parse Yahoo-style RSS 2.0 `item` blocks. */
export function parseRssHeadlineItems(xml: string, limit: number): RssHeadlineItem[] {
  const out: RssHeadlineItem[] = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(xml)) && out.length < limit) {
    const block = m[1];
    const title = extractCdataOrText(block, "title");
    const link = extractCdataOrText(block, "link");
    const pubDate = extractCdataOrText(block, "pubDate") || new Date().toISOString();
    if (!title || !link) continue;
    idx += 1;
    out.push({
      id: `rss-${idx}-${link.slice(-40)}`,
      title,
      link,
      publishedAt: pubDate,
      source: "yahoo-rss",
    });
  }
  return out;
}

export async function fetchYahooHeadlineRss(ticker: string, limit: number): Promise<RssHeadlineItem[]> {
  const t = ticker.trim();
  if (!t) return [];
  const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(t)}&region=US&lang=en-US`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml,*/*" }, signal: ctrl.signal });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssHeadlineItems(xml, Math.min(Math.max(limit, 1), 30));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
