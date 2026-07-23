import { describe, expect, test } from "bun:test";
import { classifyMarketDataFailure, formatMarketDataFailure } from "./market-data-errors";

describe("market data failure classification", () => {
  test("classifies actionable upstream failures", () => {
    expect(classifyMarketDataFailure("HTTP 429 retry-after=60")).toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 60_000,
    });
    expect(classifyMarketDataFailure("HTTP 451 restricted location").kind).toBe("network_blocked");
    expect(classifyMarketDataFailure("credentials missing (token)").kind).toBe(
      "credentials_missing"
    );
    expect(classifyMarketDataFailure("health probe returned no rows").kind).toBe("no_data");
  });

  test("formats a stable category prefix for persistence", () => {
    expect(formatMarketDataFailure("Too Many Requests")).toStartWith("[rate_limited]");
  });
});
