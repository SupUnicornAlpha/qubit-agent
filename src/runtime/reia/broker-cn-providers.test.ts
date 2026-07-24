import { describe, expect, test } from "bun:test";
import { BROKER_PROVIDERS, isBrokerProvider } from "../../types/broker";
import { createBrokerConnector, getBrokerConnector } from "./broker-connector";

describe("China broker providers", () => {
  test("provider registry includes SuperMind and Eastmoney EMT", () => {
    expect(BROKER_PROVIDERS).toContain("supermind");
    expect(BROKER_PROVIDERS).toContain("eastmoney_emt");
    expect(isBrokerProvider("supermind")).toBe(true);
    expect(isBrokerProvider("eastmoney_emt")).toBe(true);
    expect(isBrokerProvider("eastmoney")).toBe(false);
  });

  test.each(["supermind", "eastmoney_emt"] as const)(
    "%s mock connector satisfies contract",
    async (provider) => {
      const connector = createBrokerConnector({
        provider,
        mode: "mock",
        accountRef: `${provider}-test`,
      });
      const order = await connector.submitOrder({
        ticker: "600519.SH",
        side: "buy",
        quantity: 100,
        orderType: "limit",
        limitPrice: 1500,
      });
      expect(order.provider).toBe(provider);
      expect(order.status).toBe("filled");
      expect(order.brokerOrderId).toStartWith(`${provider}-`);
      expect((await connector.healthCheck()).status).toBe("healthy");
      expect(getBrokerConnector(provider).provider).toBe(provider);
    }
  );

  test("HTTP reads preserve provider config and paper mode", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedHeaders = new Headers();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ positions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const connector = createBrokerConnector({
        provider: "supermind",
        mode: "sandbox",
        accountRef: "sim-account",
        baseUrl: "http://127.0.0.1:18765",
        providerConfig: { accountId: "account-1", market: "CN" },
      });
      await connector.getPositions();
      const url = new URL(requestedUrl);
      expect(url.searchParams.get("paper")).toBe("true");
      expect(url.searchParams.has("providerConfig")).toBe(false);
      expect(JSON.parse(requestedHeaders.get("x-qubit-provider-config") ?? "{}")).toEqual({
        accountId: "account-1",
        market: "CN",
      });
      expect(requestedHeaders.get("x-qubit-paper")).toBe("true");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
