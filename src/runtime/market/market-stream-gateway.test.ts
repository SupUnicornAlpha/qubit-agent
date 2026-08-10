import { describe, expect, test } from "bun:test";
import { bridgePayloadMatchesSubscription } from "./market-stream-gateway";

const subscription = {
  symbol: "NVDA",
  exchange: "US",
  timeframe: "1d",
  channels: ["quote", "bar"] as Array<"quote" | "bar">,
};

describe("bridgePayloadMatchesSubscription", () => {
  test("rejects a quote from another symbol on a multiplexed bridge", () => {
    expect(
      bridgePayloadMatchesSubscription(subscription, {
        symbol: "AAPL",
        exchange: "US",
        lastPrice: 320,
      })
    ).toBeFalse();
  });

  test("accepts market-prefixed symbols for the subscribed contract", () => {
    expect(
      bridgePayloadMatchesSubscription(subscription, {
        symbol: "US.NVDA",
        exchange: "US",
        lastPrice: 220,
      })
    ).toBeTrue();
  });
});
