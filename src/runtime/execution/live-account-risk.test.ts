import { describe, expect, test } from "bun:test";
import { assessLiveAccountRisk } from "./live-account-risk";

const limits = {
  currency: "USD" as const,
  minAvailableCashUsd: 1_000,
  maxGrossNotionalUsd: 20_000,
  maxSymbolNotionalUsd: 10_000,
  maxOpenPositions: 3,
};

describe("live account risk", () => {
  test("uses broker available cash and marks instead of average price guesses", () => {
    expect(
      assessLiveAccountRisk({
        limits,
        balances: [{ currency: "USD", cash: 12_000, available: 11_000 }],
        positions: [{ symbol: "MSFT", qty: 10, avgPrice: 1, lastPrice: 500 }],
        side: "buy",
        symbol: "AAPL",
        orderNotionalUsd: 4_000,
      })
    ).toEqual(
      expect.objectContaining({ ok: true, grossNotionalUsd: 9_000, symbolNotionalUsd: 4_000 })
    );
    expect(
      assessLiveAccountRisk({
        limits,
        balances: [{ currency: "USD", cash: 12_000 }],
        positions: [],
        side: "buy",
        symbol: "AAPL",
        orderNotionalUsd: 4_000,
      })
    ).toEqual({ ok: false, reason: "live_account_risk_available_cash_missing" });
  });

  test("fails closed for stale-position proxy data and projected breaches", () => {
    expect(
      assessLiveAccountRisk({
        limits,
        balances: [{ currency: "USD", cash: 20_000, available: 20_000 }],
        positions: [{ symbol: "MSFT", qty: 10, avgPrice: 500 }],
        side: "buy",
        symbol: "AAPL",
        orderNotionalUsd: 1_000,
      })
    ).toEqual({ ok: false, reason: "live_account_risk_position_mark_missing:MSFT" });
    expect(
      assessLiveAccountRisk({
        limits,
        balances: [{ currency: "USD", cash: 20_000, available: 1_500 }],
        positions: [],
        side: "buy",
        symbol: "AAPL",
        orderNotionalUsd: 1_000,
      })
    ).toEqual({ ok: false, reason: "live_account_risk_min_available_cash_breached" });
  });

  test("accepts a broker-calculated signed market value for a short position", () => {
    expect(
      assessLiveAccountRisk({
        limits,
        balances: [{ currency: "USD", cash: 20_000, available: 20_000 }],
        positions: [{ symbol: "MSFT", qty: -10, avgPrice: 500, marketValue: -5_000 }],
        side: "buy",
        symbol: "AAPL",
        orderNotionalUsd: 1_000,
      })
    ).toEqual(expect.objectContaining({ ok: true, grossNotionalUsd: 6_000 }));
  });
});
