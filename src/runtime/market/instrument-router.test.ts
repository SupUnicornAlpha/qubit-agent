import { describe, expect, test } from "bun:test";
import { resolveInstrument } from "./instrument-router";

describe("instrument-router", () => {
  test("maps HK to futu provider", async () => {
    const r = await resolveInstrument({ market: "HK", symbol: "00700" });
    expect(r.market).toBe("HK");
    expect(r.brokerProvider).toBe("futu");
    expect(r.normalizedSymbol).toContain("00700");
  });

  test("maps US to ib provider", async () => {
    const r = await resolveInstrument({ market: "US", symbol: "AAPL" });
    expect(r.market).toBe("US");
    expect(r.brokerProvider).toBe("ib");
  });

  test("maps CRYPTO to ccxt provider", async () => {
    const r = await resolveInstrument({ market: "CRYPTO", symbol: "BTCUSDT" });
    expect(r.market).toBe("CRYPTO");
    expect(r.brokerProvider).toBe("ccxt");
  });
});
