/**
 * Map Yahoo `assetProfile.sector` (GICS-style English labels) to a liquid US sector ETF,
 * so we can reuse the same Yahoo headline RSS feed for「板块」资讯 proxy.
 */
export function sectorToHeadlineTicker(sector: string | null | undefined): string {
  if (!sector) return "SPY";
  const s = sector.toLowerCase();
  if (s.includes("financial")) return "XLF";
  if (s.includes("technology") || s.includes("tech")) return "XLK";
  if (s.includes("health")) return "XLV";
  if (s.includes("consumer cycl")) return "XLY";
  if (s.includes("consumer def")) return "XLP";
  if (s.includes("industrial")) return "XLI";
  if (s.includes("energy")) return "XLE";
  if (s.includes("utility") || s.includes("utilities")) return "XLU";
  if (s.includes("material") || s.includes("basic mat")) return "XLB";
  if (s.includes("real estate")) return "XLRE";
  if (s.includes("communication")) return "XLC";
  return "SPY";
}
