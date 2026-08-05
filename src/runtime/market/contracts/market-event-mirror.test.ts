import { afterEach, describe, expect, test } from "bun:test";
import {
  createMarketEventMirrorJournal,
  marketStreamEventToMarketEventV2,
  mirrorMarketStreamEvent,
} from "./market-event-mirror";

const prevMirrorEnv = process.env.QUBIT_MARKET_EVENT_MIRROR;

afterEach(() => {
  if (prevMirrorEnv === undefined) delete process.env.QUBIT_MARKET_EVENT_MIRROR;
  else process.env.QUBIT_MARKET_EVENT_MIRROR = prevMirrorEnv;
});

describe("market event mirror (D1)", () => {
  test("maps quote stream events to MarketEvent v2", () => {
    const event = marketStreamEventToMarketEventV2({
      kind: "quote",
      sequence: 12,
      symbol: "BTCUSDT",
      exchange: "CRYPTO",
      timeframe: "1m",
      source: "binance",
      emittedAt: "2026-08-04T01:30:00.200Z",
      data: {
        symbol: "BTCUSDT",
        exchange: "CRYPTO",
        lastPrice: 64000,
        timestamp: "2026-08-04T01:30:00.100Z",
        freshnessMs: 100,
      },
    });

    expect(event).not.toBeNull();
    expect(event?.kind).toBe("quote");
    expect(event?.schemaVersion).toBe(2);
    expect(event?.instrument.assetClass).toBe("crypto");
    expect(event?.source.upstreamFamily).toBe("binance");
    expect(event?.source.licenseUse).toBe("observe_only");
    expect(event?.sequence.providerSequenceAvailable).toBe(false);
    expect(event?.quality.state).toBe("observed");
    expect(event?.rawPayloadHash.startsWith("sha256:")).toBe(true);
  });

  test("skips heartbeats and mirrors gap status as gap events", () => {
    expect(
      marketStreamEventToMarketEventV2({
        kind: "heartbeat",
        sequence: 1,
        symbol: "600519",
        exchange: "SSE",
        timeframe: "1m",
        source: "futu",
        emittedAt: "2026-08-04T01:30:00.000Z",
        data: {},
      })
    ).toBeNull();

    const gap = marketStreamEventToMarketEventV2({
      kind: "status",
      sequence: 2,
      symbol: "600519",
      exchange: "SSE",
      timeframe: "1m",
      source: "futu",
      emittedAt: "2026-08-04T01:30:00.000Z",
      data: { status: "gap_detected", gapMs: 5_000 },
    });
    expect(gap?.kind).toBe("gap");
    expect(gap?.quality.state).toBe("gap_pending");
  });

  test("journal append is fail-safe and respects disable flag", () => {
    const journal = createMarketEventMirrorJournal(8);
    process.env.QUBIT_MARKET_EVENT_MIRROR = "1";

    const mirrored = mirrorMarketStreamEvent(
      {
        kind: "trade",
        sequence: 3,
        symbol: "AAPL",
        exchange: "US",
        timeframe: "1m",
        source: "ib",
        emittedAt: "2026-08-04T01:30:00.000Z",
        data: {
          id: "t1",
          price: 190,
          volume: 1,
          timestamp: "2026-08-04T01:29:59.000Z",
        },
      },
      journal
    );
    expect(mirrored?.kind).toBe("trade");
    expect(journal.size()).toBe(1);

    process.env.QUBIT_MARKET_EVENT_MIRROR = "0";
    const skipped = mirrorMarketStreamEvent(
      {
        kind: "quote",
        sequence: 4,
        symbol: "AAPL",
        exchange: "US",
        timeframe: "1m",
        source: "ib",
        emittedAt: "2026-08-04T01:30:01.000Z",
        data: { lastPrice: 191, timestamp: "2026-08-04T01:30:01.000Z" },
      },
      journal
    );
    expect(skipped).toBeNull();
    expect(journal.metrics().skipped).toBe(1);
    expect(journal.size()).toBe(1);
  });

  test("ring buffer drops oldest events beyond capacity", () => {
    const journal = createMarketEventMirrorJournal(2);
    process.env.QUBIT_MARKET_EVENT_MIRROR = "1";
    for (let i = 0; i < 3; i++) {
      mirrorMarketStreamEvent(
        {
          kind: "quote",
          sequence: i + 1,
          symbol: "ETHUSDT",
          exchange: "CRYPTO",
          timeframe: "1m",
          source: "binance",
          emittedAt: `2026-08-04T01:30:0${i}.000Z`,
          data: {
            lastPrice: 3000 + i,
            timestamp: `2026-08-04T01:30:0${i}.000Z`,
            freshnessMs: 1,
          },
        },
        journal
      );
    }
    expect(journal.size()).toBe(2);
    expect(journal.recent(2)[0]?.sequence.value).toBe(2);
    expect(journal.recent(2)[1]?.sequence.value).toBe(3);
  });
});
