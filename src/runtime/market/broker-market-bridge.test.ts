import { afterEach, describe, expect, test } from "bun:test";
import {
  getBrokerMarketBridge,
  isBrokerBridgeConfigured,
  isBrokerMarketBridgeSourceId,
  listBrokerMarketBridges,
  registerBrokerMarketBridge,
  resolveBridgeWsUrl,
  selectBrokerMarketBridge,
} from "./broker-market-bridge";

const ENV_KEYS = [
  "QUBIT_FUTU_MARKET_WS_URL",
  "QUBIT_IB_MARKET_WS_URL",
  "QUBIT_SUPERMIND_MARKET_WS_URL",
  "QUBIT_THS_MARKET_WS_URL",
  "QUBIT_MARKET_STREAM_PROVIDER",
  "QUBIT_BROKER_MARKET_WS_URL_FUTU",
] as const;

const saved: Record<string, string | undefined> = {};

function clearBridgeEnv(): void {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreBridgeEnv(): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreBridgeEnv();
});

describe("broker-market-bridge", () => {
  test("lists builtin futu / ib / supermind bridges", () => {
    const ids = listBrokerMarketBridges().map((d) => d.id).sort();
    expect(ids).toEqual(["futu", "ib", "supermind"]);
    expect(isBrokerMarketBridgeSourceId("futu_bridge")).toBe(true);
    expect(isBrokerMarketBridgeSourceId("eastmoney")).toBe(false);
  });

  test("resolves WS URL from primary or alias env keys", () => {
    clearBridgeEnv();
    expect(resolveBridgeWsUrl("futu")).toBeUndefined();
    process.env.QUBIT_BROKER_MARKET_WS_URL_FUTU = "ws://127.0.0.1:8765";
    expect(resolveBridgeWsUrl("futu")).toBe("ws://127.0.0.1:8765");
    process.env.QUBIT_FUTU_MARKET_WS_URL = "ws://127.0.0.1:9000";
    expect(resolveBridgeWsUrl("futu")).toBe("ws://127.0.0.1:9000");
  });

  test("selects preferred provider when configured", () => {
    clearBridgeEnv();
    process.env.QUBIT_FUTU_MARKET_WS_URL = "ws://futu";
    process.env.QUBIT_IB_MARKET_WS_URL = "ws://ib";
    process.env.QUBIT_MARKET_STREAM_PROVIDER = "ib";
    const selected = selectBrokerMarketBridge({ market: "CN" });
    expect(selected?.id).toBe("ib");
    expect(selected?.url).toBe("ws://ib");
  });

  test("falls back by market when preferred missing", () => {
    clearBridgeEnv();
    process.env.QUBIT_FUTU_MARKET_WS_URL = "ws://futu";
    expect(selectBrokerMarketBridge({ market: "CN" })?.id).toBe("futu");
    expect(selectBrokerMarketBridge({ market: "US" })?.id).toBe("futu");
    clearBridgeEnv();
    process.env.QUBIT_IB_MARKET_WS_URL = "ws://ib";
    expect(selectBrokerMarketBridge({ market: "US" })?.id).toBe("ib");
    expect(selectBrokerMarketBridge({ market: "CN" })).toBeNull();
  });

  test("registerBrokerMarketBridge extends selection", () => {
    clearBridgeEnv();
    registerBrokerMarketBridge({
      id: "futu",
      sourceId: "futu_bridge",
      name: "Futu OpenQuote Bridge",
      vendor: "富途 OpenD",
      markets: ["CN", "HK", "US"],
      envKeys: ["QUBIT_FUTU_MARKET_WS_URL", "QUBIT_BROKER_MARKET_WS_URL_FUTU"],
      upstreamFamily: "futu",
    });
    expect(getBrokerMarketBridge("futu")?.vendor).toBe("富途 OpenD");
    expect(isBrokerBridgeConfigured("futu")).toBe(false);
  });
});
