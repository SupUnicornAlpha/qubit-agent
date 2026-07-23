import { BaseConnector } from "../base.connector";
import type { ConnectorConfig, ConnectorMeta, HealthCheckResult } from "../../types/connector";
import type { FetchNewsParams, NewsData } from "./data.connector";

function cfgStr(config: ConnectorConfig, key: string): string | undefined {
  const v = config[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function cfgNum(config: ConnectorConfig, key: string): number | undefined {
  const v = config[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Best-effort map of arbitrary JSON rows to NewsData. */
function rowToNewsData(row: Record<string, unknown>, index: number): NewsData | null {
  const title = row.title ?? row.headline ?? row.subject;
  if (typeof title !== "string" || !title.trim()) return null;
  const id = typeof row.id === "string" ? row.id : `row-${index}`;
  const content =
    typeof row.content === "string"
      ? row.content
      : typeof row.summary === "string"
        ? row.summary
        : typeof row.body === "string"
          ? row.body
          : "";
  const publishedAt =
    typeof row.publishedAt === "string"
      ? row.publishedAt
      : typeof row.date === "string"
        ? row.date
        : typeof row.time === "string"
          ? row.time
          : "";
  const source = typeof row.source === "string" ? row.source : "external";
  const symbols = Array.isArray(row.symbols)
    ? row.symbols.map(String)
    : Array.isArray(row.tickers)
      ? row.tickers.map(String)
      : [];
  const sentimentScore =
    typeof row.sentimentScore === "number"
      ? row.sentimentScore
      : typeof row.sentiment === "number"
        ? row.sentiment
        : undefined;
  return {
    id,
    title: title.trim(),
    content,
    publishedAt,
    source,
    symbols,
    ...(sentimentScore !== undefined ? { sentimentScore } : {}),
  };
}

/**
 * Built-in news connector: optional HTTP JSON feed when `newsApiBaseUrl` is set in connector init
 * (persisted via UI → SQLite). Synthetic rows are opt-in and are always marked so
 * they cannot be mistaken for current research evidence.
 */
export class QubitNativeNewsConnector extends BaseConnector {
  readonly meta: ConnectorMeta = {
    name: "qubit-news",
    version: "0.1.0",
    connectorType: "data",
    capabilities: ["fetch_news", "fetch_news_sentiment", "extract_event", "score_sentiment"],
    assetClasses: ["stock"],
    latencyProfile: "batch",
    description:
      "Built-in news: HTTP JSON when configured; optional marked synthetic rows for demos.",
  };

  private newsApiBaseUrl: string | undefined;
  private newsApiKey: string | undefined;
  private newsFetchPath = "/";
  private newsTimeoutMs = 15_000;
  private syntheticWhenEmpty = false;

  protected async onInit(config: ConnectorConfig): Promise<void> {
    this.newsApiBaseUrl = cfgStr(config, "newsApiBaseUrl");
    this.newsApiKey = cfgStr(config, "newsApiKey");
    this.newsFetchPath = cfgStr(config, "newsFetchPath") ?? "/";
    this.newsTimeoutMs = cfgNum(config, "newsTimeoutMs") ?? 15_000;
    const swe = config["syntheticWhenEmpty"];
    if (typeof swe === "boolean") this.syntheticWhenEmpty = swe;
    else this.syntheticWhenEmpty = cfgStr(config, "syntheticWhenEmpty") === "true";
  }

  protected async onHealthcheck(): Promise<Omit<HealthCheckResult, "latencyMs" | "checkedAt">> {
    if (this.newsApiBaseUrl) {
      return { status: "healthy", message: `qubit-news: HTTP ${this.newsApiBaseUrl}` };
    }
    return {
      status: "degraded",
      message: this.syntheticWhenEmpty
        ? "qubit-news: synthetic demo mode; unavailable for research evidence"
        : "qubit-news: no news API URL configured",
    };
  }

  protected async onShutdown(): Promise<void> {}

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    switch (operation) {
      case "fetch_news":
      case "fetch_news_sentiment":
        return (await this.fetchNewsWithSentiment(payload)) as TOutput;
      case "extract_event":
        return this.extractEvent(payload) as TOutput;
      case "score_sentiment":
        return this.scoreSentiment(payload) as TOutput;
      default:
        throw new Error(`qubit-news: unknown operation "${operation}"`);
    }
  }

  private async fetchNewsWithSentiment(payload: unknown): Promise<{
    items: NewsData[];
    aggregateSentiment: { score: number; label: string; sampleSize: number };
  }> {
    const items = await this.fetchNewsResolved(payload);
    let scoreSum = 0;
    let scored = 0;
    for (const item of items) {
      if (typeof item.sentimentScore === "number") {
        scoreSum += item.sentimentScore;
        scored++;
      } else {
        const s = this.scoreSentiment({ text: `${item.title} ${item.content}` });
        scoreSum += s.score;
        scored++;
      }
    }
    const avg = scored > 0 ? scoreSum / scored : 0;
    const label = avg > 0.15 ? "positive" : avg < -0.15 ? "negative" : "neutral";
    return {
      items,
      aggregateSentiment: { score: avg, label, sampleSize: items.length },
    };
  }

  private async fetchNewsResolved(payload: unknown): Promise<NewsData[]> {
    const p = (payload ?? {}) as Partial<FetchNewsParams>;
    const keywords = Array.isArray(p.keywords) ? p.keywords.map(String) : [];
    const symbols = Array.isArray(p.symbols) ? p.symbols.map(String) : [];

    if (this.newsApiBaseUrl) {
      try {
        const base = this.newsApiBaseUrl.replace(/\/$/, "");
        const path = this.newsFetchPath.startsWith("/")
          ? this.newsFetchPath
          : `/${this.newsFetchPath}`;
        const url = new URL(base + path);
        url.searchParams.set("startDate", p.startDate ?? "");
        url.searchParams.set("endDate", p.endDate ?? "");
        if (keywords.length) url.searchParams.set("keywords", keywords.join(","));
        if (symbols.length) url.searchParams.set("symbols", symbols.join(","));
        if (typeof p.limit === "number") url.searchParams.set("limit", String(p.limit));

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.newsTimeoutMs);
        try {
          const headers: Record<string, string> = { Accept: "application/json" };
          if (this.newsApiKey) {
            headers.Authorization = `Bearer ${this.newsApiKey}`;
            headers["X-API-Key"] = this.newsApiKey;
          }

          const res = await fetch(url.toString(), { signal: ctrl.signal, headers });
          if (!res.ok) {
            throw new Error(`news HTTP ${res.status}`);
          }
          const json = (await res.json()) as unknown;
          const mapped = this.parseNewsJson(json).filter((item) =>
            this.isWithinRequestedWindow(item, p.startDate, p.endDate)
          );
          if (mapped.length > 0) return mapped;
          if (!this.syntheticWhenEmpty) return [];
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        console.warn("[qubit-news] HTTP fetch_news failed:", e instanceof Error ? e.message : e);
        if (!this.syntheticWhenEmpty) return [];
      }
    }

    if (keywords.length === 0 && symbols.length === 0) {
      return [];
    }
    if (!this.syntheticWhenEmpty) return [];
    const now = new Date().toISOString();
    return [
      {
        id: "stub-1",
        title: `[stub] News for ${symbols.join(",") || keywords.join(",")}`,
        content: "Synthetic news row from QubitNativeNewsConnector; set news API URL in 配置中心.",
        publishedAt: now,
        source: "qubit-native",
        symbols,
        sentimentScore: 0,
        isSynthetic: true,
      },
    ];
  }

  private parseNewsJson(json: unknown): NewsData[] {
    let rows: unknown[] = [];
    if (Array.isArray(json)) {
      rows = json;
    } else if (json && typeof json === "object") {
      const o = json as Record<string, unknown>;
      if (Array.isArray(o.items)) rows = o.items;
      else if (Array.isArray(o.data)) rows = o.data;
      else if (Array.isArray(o.results)) rows = o.results;
      else if (Array.isArray(o.news)) rows = o.news;
    }
    const out: NewsData[] = [];
    rows.forEach((row, i) => {
      if (row && typeof row === "object") {
        const n = rowToNewsData(row as Record<string, unknown>, i);
        if (n) out.push(n);
      }
    });
    return out;
  }

  private isWithinRequestedWindow(
    item: NewsData,
    startDate?: string,
    endDate?: string
  ): boolean {
    const publishedMs = Date.parse(item.publishedAt);
    if (!Number.isFinite(publishedMs)) return false;
    const startMs = startDate ? Date.parse(`${startDate.slice(0, 10)}T00:00:00.000Z`) : Number.NaN;
    const endMs = endDate ? Date.parse(`${endDate.slice(0, 10)}T23:59:59.999Z`) : Number.NaN;
    if (Number.isFinite(startMs) && publishedMs < startMs) return false;
    if (Number.isFinite(endMs) && publishedMs > endMs) return false;
    return true;
  }

  private extractEvent(payload: unknown): { events: Array<Record<string, unknown>> } {
    const text =
      payload && typeof payload === "object" && "text" in (payload as object)
        ? String((payload as Record<string, unknown>)["text"] ?? "")
        : String(payload ?? "");
    if (!text.trim()) {
      return { events: [] };
    }
    return {
      events: [
        {
          type: "unspecified",
          summary: text.slice(0, 200),
          confidence: 0.1,
          note: "stub extract_event — use LLM or NER service in production",
        },
      ],
    };
  }

  private scoreSentiment(payload: unknown): { score: number; label: string } {
    const text =
      payload && typeof payload === "object" && "text" in (payload as object)
        ? String((payload as Record<string, unknown>)["text"] ?? "")
        : "";
    if (!text.trim()) {
      return { score: 0, label: "neutral" };
    }
    return { score: 0, label: "neutral" };
  }
}
