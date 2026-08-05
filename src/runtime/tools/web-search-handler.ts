import type { BuiltinToolHandler } from "./types";
import { decodeBoundedText, stripHtmlToText } from "./web-ssrf";

export type WebSearchProvider = "duckduckgo" | "brave" | "serper";

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchSuccess {
  ok: true;
  provider: WebSearchProvider;
  query: string;
  count: number;
  results: WebSearchResultItem[];
  source: "web";
}

export interface WebSearchFailure {
  ok: false;
  error: string;
  provider?: WebSearchProvider;
  query?: string;
  source: "web";
}

export type WebSearchOutcome = WebSearchSuccess | WebSearchFailure;

type FetchLike = typeof fetch;

export function resolveWebSearchProvider(env: NodeJS.ProcessEnv = process.env): WebSearchProvider {
  const raw = (env.WEB_SEARCH_PROVIDER ?? "duckduckgo").trim().toLowerCase();
  if (raw === "brave" || raw === "serper" || raw === "duckduckgo") return raw;
  return "duckduckgo";
}

function clampCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(Math.floor(n), 10);
}

async function searchBrave(
  query: string,
  count: number,
  apiKey: string,
  fetchImpl: FetchLike
): Promise<WebSearchOutcome> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  const response = await fetchImpl(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
      "User-Agent": "qubit-agent/web.search",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return {
      ok: false,
      error: `brave search failed: HTTP ${response.status}`,
      provider: "brave",
      query,
      source: "web",
    };
  }
  const body = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  const results = (body.web?.results ?? [])
    .map((r) => ({
      title: String(r.title ?? "").trim(),
      url: String(r.url ?? "").trim(),
      snippet: String(r.description ?? "").trim().slice(0, 500),
    }))
    .filter((r) => r.title && r.url)
    .slice(0, count);
  return { ok: true, provider: "brave", query, count: results.length, results, source: "web" };
}

async function searchSerper(
  query: string,
  count: number,
  apiKey: string,
  fetchImpl: FetchLike
): Promise<WebSearchOutcome> {
  const response = await fetchImpl("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
      "User-Agent": "qubit-agent/web.search",
    },
    body: JSON.stringify({ q: query, num: count }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return {
      ok: false,
      error: `serper search failed: HTTP ${response.status}`,
      provider: "serper",
      query,
      source: "web",
    };
  }
  const body = (await response.json()) as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  const results = (body.organic ?? [])
    .map((r) => ({
      title: String(r.title ?? "").trim(),
      url: String(r.link ?? "").trim(),
      snippet: String(r.snippet ?? "").trim().slice(0, 500),
    }))
    .filter((r) => r.title && r.url)
    .slice(0, count);
  return { ok: true, provider: "serper", query, count: results.length, results, source: "web" };
}

/**
 * Best-effort DuckDuckGo HTML scrape for zero-config installs.
 * Prefer Brave/Serper in production.
 */
export function parseDuckDuckGoHtml(html: string, count: number): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  // Classic result block: <a class="result__a" href="...">title</a> ... result__snippet
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && results.length < count) {
    const href = String(m[1] ?? "").trim();
    const title = stripHtmlToText(m[2] ?? "").slice(0, 300);
    const snippet = stripHtmlToText(m[3] ?? "").slice(0, 500);
    const url = unwrapDuckDuckGoRedirect(href);
    if (!title || !url) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

function unwrapDuckDuckGoRedirect(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    if (u.hostname.includes("duckduckgo.com") && u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    /* ignore */
  }
  return "";
}

async function searchDuckDuckGo(
  query: string,
  count: number,
  fetchImpl: FetchLike
): Promise<WebSearchOutcome> {
  const body = new URLSearchParams({ q: query });
  const response = await fetchImpl("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "qubit-agent/web.search",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return {
      ok: false,
      error: `duckduckgo search failed: HTTP ${response.status}`,
      provider: "duckduckgo",
      query,
      source: "web",
    };
  }
  const html = decodeBoundedText(await response.arrayBuffer());
  const results = parseDuckDuckGoHtml(html, count);
  if (results.length === 0) {
    return {
      ok: false,
      error:
        "duckduckgo search returned no parseable results（可设置 WEB_SEARCH_PROVIDER=brave|serper）",
      provider: "duckduckgo",
      query,
      source: "web",
    };
  }
  return {
    ok: true,
    provider: "duckduckgo",
    query,
    count: results.length,
    results,
    source: "web",
  };
}

/** Injectable core for tests. */
export async function runWebSearch(
  params: Record<string, unknown>,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike } = {}
): Promise<WebSearchOutcome> {
  const query = String(params.query ?? params.q ?? "").trim();
  if (!query) return { ok: false, error: "query is required", source: "web" };
  if (query.length > 500) {
    return { ok: false, error: "query too long (max 500 chars)", source: "web" };
  }

  const count = clampCount(params.count ?? params.num ?? params.limit);
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const provider = resolveWebSearchProvider(env);

  try {
    if (provider === "brave") {
      const apiKey = env.BRAVE_SEARCH_API_KEY?.trim();
      if (!apiKey) {
        return {
          ok: false,
          error: "WEB_SEARCH_PROVIDER=brave 需要 BRAVE_SEARCH_API_KEY",
          provider,
          query,
          source: "web",
        };
      }
      return await searchBrave(query, count, apiKey, fetchImpl);
    }
    if (provider === "serper") {
      const apiKey = env.SERPER_API_KEY?.trim();
      if (!apiKey) {
        return {
          ok: false,
          error: "WEB_SEARCH_PROVIDER=serper 需要 SERPER_API_KEY",
          provider,
          query,
          source: "web",
        };
      }
      return await searchSerper(query, count, apiKey, fetchImpl);
    }
    return await searchDuckDuckGo(query, count, fetchImpl);
  } catch (error) {
    const message =
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout (15s)"
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, error: `search failed: ${message}`, provider, query, source: "web" };
  }
}

export const WEB_SEARCH_HANDLER: BuiltinToolHandler = async (_ctx, params) => runWebSearch(params);
