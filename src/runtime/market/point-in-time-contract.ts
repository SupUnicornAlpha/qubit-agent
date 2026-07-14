import type { BarData } from "../../connectors/data/data.connector";

export interface MarketDataProvenance {
  provider: string;
  fetchedAt: string;
  dataAsof: string;
  adjustType: "none" | "pre" | "post";
  security: {
    symbol: string;
    exchange: string;
    listingStatus: "active" | "suspended" | "delisted";
    listedAt?: string | null;
    delistedAt?: string | null;
  };
}

export interface PointInTimeValidation {
  valid: boolean;
  bars: BarData[];
  errors: string[];
  warnings: string[];
  lineage: MarketDataProvenance & {
    barCount: number;
    firstBarAt: string | null;
    lastBarAt: string | null;
    freshnessMs: number | null;
  };
}

export function validatePointInTimeBars(
  rawBars: BarData[],
  provenance: MarketDataProvenance,
): PointInTimeValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fetchedAtMs = Date.parse(provenance.fetchedAt);
  const dataAsofMs = Date.parse(provenance.dataAsof);
  if (!Number.isFinite(fetchedAtMs)) errors.push("invalid_fetched_at");
  if (!Number.isFinite(dataAsofMs)) errors.push("invalid_data_asof");
  if (Number.isFinite(fetchedAtMs) && Number.isFinite(dataAsofMs) && dataAsofMs > fetchedAtMs) {
    errors.push("data_asof_after_fetch_time");
  }
  const sorted = [...rawBars].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const seen = new Set<string>();
  const bars: BarData[] = [];
  for (const bar of sorted) {
    const timestampMs = Date.parse(bar.timestamp);
    if (!Number.isFinite(timestampMs)) {
      errors.push(`invalid_timestamp:${bar.timestamp}`);
      continue;
    }
    if (Number.isFinite(dataAsofMs) && timestampMs > dataAsofMs) {
      errors.push(`future_bar:${bar.timestamp}`);
      continue;
    }
    if (seen.has(bar.timestamp)) {
      errors.push(`duplicate_bar:${bar.timestamp}`);
      continue;
    }
    seen.add(bar.timestamp);
    if (![bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)) {
      errors.push(`non_finite_bar:${bar.timestamp}`);
      continue;
    }
    if (bar.low > Math.min(bar.open, bar.close) || bar.high < Math.max(bar.open, bar.close) || bar.low > bar.high) {
      errors.push(`invalid_ohlc:${bar.timestamp}`);
      continue;
    }
    if (bar.volume < 0 || bar.turnover < 0) {
      errors.push(`negative_volume_or_turnover:${bar.timestamp}`);
      continue;
    }
    const listedAt = provenance.security.listedAt ? Date.parse(provenance.security.listedAt) : null;
    const delistedAt = provenance.security.delistedAt ? Date.parse(provenance.security.delistedAt) : null;
    if (listedAt != null && Number.isFinite(listedAt) && timestampMs < listedAt) {
      errors.push(`bar_before_listing:${bar.timestamp}`);
      continue;
    }
    if (delistedAt != null && Number.isFinite(delistedAt) && timestampMs > delistedAt) {
      errors.push(`bar_after_delisting:${bar.timestamp}`);
      continue;
    }
    bars.push(bar);
  }
  if (provenance.security.listingStatus === "suspended") warnings.push("security_suspended");
  if (provenance.security.listingStatus === "delisted") warnings.push("security_delisted");
  if (bars.length === 0) errors.push("no_valid_bars");
  return {
    valid: errors.length === 0,
    bars,
    errors: [...new Set(errors)],
    warnings,
    lineage: {
      ...provenance,
      barCount: bars.length,
      firstBarAt: bars[0]?.timestamp ?? null,
      lastBarAt: bars.at(-1)?.timestamp ?? null,
      freshnessMs: Number.isFinite(fetchedAtMs) && Number.isFinite(dataAsofMs)
        ? Math.max(0, fetchedAtMs - dataAsofMs)
        : null,
    },
  };
}
