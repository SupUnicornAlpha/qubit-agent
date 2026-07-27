import { describe, expect, test } from "bun:test";
import { MarketBarAggregator } from "./market-stream-aggregator";

describe("MarketBarAggregator", () => {
  test("aggregates prices inside one timeframe and closes on rollover", () => {
    const aggregator = new MarketBarAggregator("600519", "SH", "1m");
    const first = aggregator.update({
      price: 100,
      volume: 10,
      turnover: 1000,
      timestamp: "2026-07-26T01:30:05.000Z",
    });
    const second = aggregator.update({
      price: 102,
      volume: 5,
      turnover: 510,
      timestamp: "2026-07-26T01:30:40.000Z",
    });
    const rollover = aggregator.update({
      price: 101,
      volume: 2,
      turnover: 202,
      timestamp: "2026-07-26T01:31:01.000Z",
    });

    expect(first?.bar.open).toBe(100);
    expect(second?.bar.high).toBe(102);
    expect(second?.bar.volume).toBe(15);
    expect(rollover?.closedBar?.close).toBe(102);
    expect(rollover?.bar.open).toBe(101);
  });

  test("rejects invalid prices", () => {
    const aggregator = new MarketBarAggregator("AAPL", "US", "1m");
    expect(
      aggregator.update({
        price: Number.NaN,
        timestamp: "2026-07-26T01:30:00.000Z",
      })
    ).toBeNull();
  });
});
