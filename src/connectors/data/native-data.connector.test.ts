import { describe, expect, test } from "bun:test";
import type {
  BarData,
  FetchBarsParams,
  FetchQuoteParams,
  FetchTicksParams,
  QuoteData,
} from "./data.connector";
import { QubitNativeDataConnector } from "./native-data.connector";

class StubNativeDataConnector extends QubitNativeDataConnector {
  readonly requests: FetchBarsParams[] = [];

  override async fetchBars(params: FetchBarsParams): Promise<BarData[]> {
    this.requests.push(params);
    return [
      {
        symbol: params.symbol,
        exchange: params.exchange,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 100,
        turnover: 150,
        timestamp: params.endDate,
      },
    ];
  }
}

describe("QubitNativeDataConnector market request adapter", () => {
  test("accepts batch tickers and normalizes aliases before source routing", async () => {
    const connector = new StubNativeDataConnector();
    await connector.init({});
    const bars = await connector.execute<BarData[]>("fetch_klines", {
      tickers: ["SH600000", "300274.SZ"],
      interval: "60m",
      count: 30,
      workflowRunId: "wf-test",
    });

    expect(connector.requests).toHaveLength(2);
    expect(connector.requests.map((request) => [request.symbol, request.exchange])).toEqual([
      ["600000", "SH"],
      ["300274", "SZ"],
    ]);
    expect(connector.requests.every((request) => request.period === "1h")).toBe(true);
    expect(bars.map((bar) => bar.symbol)).toEqual(["600000", "300274"]);
  });

  test("fetch_quote accepts symbols[] without scalar symbol (DB repro)", async () => {
    class StubQuoteConnector extends QubitNativeDataConnector {
      override async fetchQuote(params: FetchQuoteParams): Promise<QuoteData> {
        return {
          symbol: params.symbol,
          exchange: params.exchange ?? "SH",
          source: "stub",
          lastPrice: 10,
          timestamp: "2026-01-01T00:00:00Z",
          freshnessMs: 0,
        };
      }
    }
    const connector = new StubQuoteConnector();
    await connector.init({});
    const result = await connector.execute<{
      quotes: Array<{ symbol: string }>;
    }>("fetch_quote", {
      symbols: ["603986.SH", "002384.SZ"],
    });
    expect(result.quotes.map((q) => q.symbol)).toEqual(["603986.SH", "002384.SZ"]);
  });

  test("fetch_quote missing symbol → missing_symbol with receivedKeys", async () => {
    const connector = new StubNativeDataConnector();
    await connector.init({});
    await expect(connector.execute("fetch_quote", {})).rejects.toThrow(
      /missing_symbol: fetch_quote:.*receivedKeys=\(none\)/
    );
  });

  test("fetch_ticks accepts symbols[] and returns {ticks} for batch", async () => {
    class StubTicksConnector extends QubitNativeDataConnector {
      override async fetchTicks(params: FetchTicksParams): Promise<
        Array<{
          symbol: string;
          exchange: string;
          lastPrice: number;
          bidPrice: number;
          askPrice: number;
          bidVolume: number;
          askVolume: number;
          volume: number;
          timestamp: string;
        }>
      > {
        return [
          {
            symbol: params.symbol,
            exchange: params.exchange,
            lastPrice: 1,
            bidPrice: 1,
            askPrice: 1,
            bidVolume: 0,
            askVolume: 0,
            volume: 0,
            timestamp: "2026-01-01T00:00:00Z",
          },
        ];
      }
    }
    const connector = new StubTicksConnector();
    await connector.init({});
    const result = await connector.execute<{
      ticks: Array<{ symbol: string }>;
    }>("fetch_ticks", {
      symbols: ["603986.SH", "002384.SZ"],
    });
    expect(result.ticks.map((t) => t.symbol)).toEqual(["603986.SH", "002384.SZ"]);
  });

  test("fetch_ticks missing symbol → missing_symbol with receivedKeys", async () => {
    const connector = new StubNativeDataConnector();
    await connector.init({});
    await expect(connector.execute("fetch_ticks", {})).rejects.toThrow(
      /missing_symbol: fetch_ticks:.*receivedKeys=\(none\)/
    );
  });
});
