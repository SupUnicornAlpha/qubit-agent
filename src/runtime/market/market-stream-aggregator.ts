import type { BarData } from "../../connectors/data/data.connector";

function timeframeMs(timeframe: string): number {
  switch (timeframe.trim().toLowerCase()) {
    case "1m":
      return 60_000;
    case "5m":
      return 5 * 60_000;
    case "15m":
      return 15 * 60_000;
    case "30m":
      return 30 * 60_000;
    case "1h":
      return 60 * 60_000;
    case "4h":
      return 4 * 60 * 60_000;
    case "1w":
      return 7 * 24 * 60 * 60_000;
    default:
      return 24 * 60 * 60_000;
  }
}

export class MarketBarAggregator {
  private current: BarData | null = null;

  constructor(
    private readonly symbol: string,
    private readonly exchange: string,
    private readonly timeframe: string
  ) {}

  update(input: {
    price: number;
    volume?: number;
    turnover?: number;
    timestamp: string;
  }): { bar: BarData; closedBar: BarData | null } | null {
    if (!Number.isFinite(input.price) || input.price <= 0) return null;
    const timestampMs = Date.parse(input.timestamp);
    if (!Number.isFinite(timestampMs)) return null;
    const window = timeframeMs(this.timeframe);
    const bucketMs = Math.floor(timestampMs / window) * window;
    const bucketTimestamp = new Date(bucketMs).toISOString();
    let closedBar: BarData | null = null;
    if (!this.current || this.current.timestamp !== bucketTimestamp) {
      closedBar = this.current;
      this.current = {
        symbol: this.symbol,
        exchange: this.exchange || "UNKNOWN",
        open: input.price,
        high: input.price,
        low: input.price,
        close: input.price,
        volume: Math.max(0, input.volume ?? 0),
        turnover: Math.max(0, input.turnover ?? 0),
        timestamp: bucketTimestamp,
      };
    } else {
      this.current = {
        ...this.current,
        high: Math.max(this.current.high, input.price),
        low: Math.min(this.current.low, input.price),
        close: input.price,
        volume: this.current.volume + Math.max(0, input.volume ?? 0),
        turnover: this.current.turnover + Math.max(0, input.turnover ?? 0),
      };
    }
    return { bar: this.current, closedBar };
  }
}
