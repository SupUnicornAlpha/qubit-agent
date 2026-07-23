import { describe, expect, test } from "bun:test";
import { QubitNativeNewsConnector } from "./native-news.connector";

const request = {
  symbols: ["002384.SZ"],
  startDate: "2026-07-15",
  endDate: "2026-07-22",
  limit: 10,
};

describe("QubitNativeNewsConnector evidence safety", () => {
  test("does not fabricate a current news row when no real source is configured", async () => {
    const connector = new QubitNativeNewsConnector();
    await connector.init({});
    const output = await connector.execute<{
      items: Array<{ isSynthetic?: boolean }>;
      aggregateSentiment: { sampleSize: number };
    }>("fetch_news", request);
    expect(output.items).toEqual([]);
    expect(output.aggregateSentiment.sampleSize).toBe(0);
    expect((await connector.healthcheck()).status).toBe("degraded");
  });

  test("explicit demo mode marks synthetic rows so evidence gates can reject them", async () => {
    const connector = new QubitNativeNewsConnector();
    await connector.init({ syntheticWhenEmpty: true });
    const output = await connector.execute<{ items: Array<{ isSynthetic?: boolean }> }>(
      "fetch_news",
      request
    );
    expect(output.items).toHaveLength(1);
    expect(output.items[0]?.isSynthetic).toBe(true);
  });
});
