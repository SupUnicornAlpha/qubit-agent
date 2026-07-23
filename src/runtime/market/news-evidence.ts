import type { NewsData } from "../../connectors/data/data.connector";

export interface NewsEvidenceItem {
  title: string;
  content?: string;
  publishedAt: string;
  source?: string;
  symbols?: string[];
  isSynthetic?: boolean;
}

export type NewsEvidenceRejection =
  | "synthetic"
  | "missing_or_invalid_time"
  | "stale"
  | "irrelevant";

export interface NewsEvidenceAssessment<T> {
  accepted: T[];
  rejected: Record<NewsEvidenceRejection, number>;
  latestPublishedAt: string | null;
}

function normalizedTokens(symbol: string, aliases: string[]): string[] {
  const raw = [symbol, symbol.split(".")[0] ?? "", ...aliases]
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 2);
  return Array.from(new Set(raw));
}

function isSynthetic(item: NewsEvidenceItem): boolean {
  if (item.isSynthetic) return true;
  const source = (item.source ?? "").toLowerCase();
  const text = `${item.title} ${item.content ?? ""}`.toLowerCase();
  return source === "qubit-native" || /\[stub\]|\bsynthetic\b|占位数据|演示数据/.test(text);
}

function isRelevant(item: NewsEvidenceItem, tokens: string[]): boolean {
  const declared = (item.symbols ?? []).flatMap((value) => normalizedTokens(value, []));
  if (declared.some((value) => tokens.includes(value))) return true;
  const text = `${item.title} ${item.content ?? ""}`.toLowerCase();
  return tokens.some((token) => text.includes(token));
}

export function assessNewsEvidence<T extends NewsEvidenceItem>(
  items: T[],
  options: {
    symbol: string;
    aliases?: string[];
    asOf?: Date;
    maxAgeDays?: number;
    requireSymbolRelevance?: boolean;
    allowHistorical?: boolean;
  }
): NewsEvidenceAssessment<T> {
  const asOf = options.asOf ?? new Date();
  const maxAgeMs = Math.max(1, options.maxAgeDays ?? 7) * 86_400_000;
  const tokens = normalizedTokens(options.symbol, options.aliases ?? []);
  const rejected: Record<NewsEvidenceRejection, number> = {
    synthetic: 0,
    missing_or_invalid_time: 0,
    stale: 0,
    irrelevant: 0,
  };
  const accepted: T[] = [];

  for (const item of items) {
    if (isSynthetic(item)) {
      rejected.synthetic++;
      continue;
    }
    const publishedMs = Date.parse(item.publishedAt);
    if (!Number.isFinite(publishedMs) || publishedMs > asOf.getTime() + 5 * 60_000) {
      rejected.missing_or_invalid_time++;
      continue;
    }
    if (!options.allowHistorical && asOf.getTime() - publishedMs > maxAgeMs) {
      rejected.stale++;
      continue;
    }
    if (options.requireSymbolRelevance !== false && !isRelevant(item, tokens)) {
      rejected.irrelevant++;
      continue;
    }
    accepted.push(item);
  }

  accepted.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  return {
    accepted,
    rejected,
    latestPublishedAt: accepted[0]?.publishedAt ?? null,
  };
}

export function newsDataIsSynthetic(item: NewsData): boolean {
  return isSynthetic(item);
}
