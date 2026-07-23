import { describe, expect, test } from "bun:test";
import { resolveMarketDataNetworkRoute } from "./market-data-network";

describe("market data network routing", () => {
  test("prefers explicit source/global proxy configuration", () => {
    const route = resolveMarketDataNetworkRoute(
      {
        "qubit-data": {
          marketDataNetworkMode: "auto",
          marketDataProxyUrl: "http://127.0.0.1:7896",
        },
      },
      "yahoo_chart"
    );
    expect(route).toEqual({
      mode: "auto",
      proxyUrl: "http://127.0.0.1:7896",
      source: "config",
    });
  });

  test("direct mode ignores configured proxies", () => {
    const route = resolveMarketDataNetworkRoute(
      {
        "qubit-data": {
          marketDataNetworkMode: "direct",
          marketDataProxyUrl: "http://127.0.0.1:7896",
        },
      },
      "eastmoney"
    );
    expect(route.proxyUrl).toBeNull();
    expect(route.source).toBe("direct");
  });

  test("proxy mode requires a proxy URL", () => {
    const previousHttps = process.env.HTTPS_PROXY;
    const previousHttp = process.env.HTTP_PROXY;
    process.env.HTTPS_PROXY = undefined;
    process.env.HTTP_PROXY = undefined;
    try {
      expect(() =>
        resolveMarketDataNetworkRoute(
          { "qubit-data": { marketDataNetworkMode: "proxy", marketDataUseSystemProxy: false } },
          "binance_crypto"
        )
      ).toThrow("marketDataProxyUrl");
    } finally {
      if (previousHttps === undefined) process.env.HTTPS_PROXY = undefined;
      else process.env.HTTPS_PROXY = previousHttps;
      if (previousHttp === undefined) process.env.HTTP_PROXY = undefined;
      else process.env.HTTP_PROXY = previousHttp;
    }
  });
});
