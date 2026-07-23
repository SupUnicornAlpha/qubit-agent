import { describe, expect, test } from "bun:test";
import type { BarData, FetchBarsParams } from "./data.connector";
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
});
