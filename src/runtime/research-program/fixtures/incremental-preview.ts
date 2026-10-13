/** Deterministic synthetic data for tests and the explicitly requested preview.
 * Never registered by application bootstrap; never represents market performance. */
import { buildMarketSnapshotRecord } from "../../market/contracts/market-snapshot-service";

export function buildIncrementalPreviewSnapshot(length = 220, symbolCount = 10) {
  const symbols = Array.from(
    { length: symbolCount },
    (_, i) => `DEMO${String(i + 1).padStart(2, "0")}`
  );
  const dates: string[] = [];
  for (let i = 0; dates.length < length; i++) {
    const date = new Date(Date.UTC(2025, 0, 2 + i));
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) dates.push(date.toISOString());
  }
  const alpha = (day: number, symbol: number) =>
    Math.sin(day * 0.83 + symbol * 0.67) + Math.cos(day * 0.26 - symbol * 0.82);
  const barsByInstrument = Object.fromEntries(
    symbols.map((symbol, si) => {
      let price = 100 + si * 5;
      return [
        `US:${symbol}`,
        dates.map((timestamp, di) => {
          price *= Math.exp(0.0002 + 0.006 * alpha(di - 2, si));
          const close = price * (1 + 0.001 * Math.sin(di + si));
          const volume = 100_000 + 30_000 * alpha(di, si);
          return {
            timestamp,
            open: price,
            close,
            high: Math.max(price, close) + 0.2,
            low: Math.min(price, close) - 0.2,
            volume,
            turnover: volume * close,
          };
        }),
      ];
    })
  );
  const startDate = dates[0]?.slice(0, 10) ?? "2025-01-02";
  const endDate = dates.at(-1)?.slice(0, 10) ?? startDate;
  const record = buildMarketSnapshotRecord({
    purpose: "research",
    asOf: `${endDate}T23:59:59.000Z`,
    instruments: symbols.map((symbol) => ({ symbol, venue: "US", assetClass: "equity" })),
    window: { start: startDate, end: endDate },
    sources: [
      {
        provider: "synthetic-preview-only",
        feed: "synthetic-preview-only",
        upstreamFamily: "synthetic-preview-only",
      },
    ],
    timeframe: "1d",
    limit: length,
    barsByInstrument,
  });
  return { record, symbols, startDate, endDate };
}
