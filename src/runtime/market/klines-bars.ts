import type { BarData } from "../../connectors/data/data.connector";

/** 将细周期 K 线按固定时间窗合并（如 60m → 4h）。 */
export function aggregateBarsByMsWindow(
  bars: BarData[],
  windowMs: number,
  symbol: string,
  exchange: string
): BarData[] {
  if (bars.length === 0) return [];
  const sorted = [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const out: BarData[] = [];
  let bucketKey = Number.NaN;
  let bucket: BarData[] = [];
  const floorKey = (iso: string) => {
    const t = new Date(iso).getTime();
    return Math.floor(t / windowMs) * windowMs;
  };
  const flush = () => {
    if (bucket.length === 0) return;
    const o = bucket[0].open;
    const c = bucket[bucket.length - 1].close;
    const h = Math.max(...bucket.map((x) => x.high));
    const l = Math.min(...bucket.map((x) => x.low));
    const vol = bucket.reduce((s, x) => s + x.volume, 0);
    out.push({
      symbol,
      exchange,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: vol,
      turnover: 0,
      timestamp: new Date(bucketKey).toISOString(),
    });
    bucket = [];
  };
  for (const b of sorted) {
    const k = floorKey(b.timestamp);
    if (bucket.length === 0) {
      bucketKey = k;
      bucket = [b];
      continue;
    }
    if (k === bucketKey) {
      bucket.push(b);
    } else {
      flush();
      bucketKey = k;
      bucket = [b];
    }
  }
  flush();
  return out;
}
