import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/sqlite/migrate";
import {
  bootstrapMarketDataSources,
  listMarketDataSources,
  recordMarketDataSourceAttempt,
  selectMarketDataSourcePlan,
} from "./market-data-source-control";

beforeAll(async () => {
  await runMigrations();
  await bootstrapMarketDataSources({ "qubit-data": { klinesDataSource: "auto" } });
});

describe("market data source control plane", () => {
  test("registers all production source definitions with capabilities", async () => {
    const rows = await listMarketDataSources();
    expect(rows.map((row) => row.id).sort()).toEqual(
      ["akshare", "akshare_tencent", "binance_crypto", "eastmoney", "tushare_daily", "wind", "yahoo_chart", "yfinance"].sort()
    );
    expect(rows.find((row) => row.id === "tushare_daily")?.credentialsReady).toBe(false);
    expect(rows.find((row) => row.id === "eastmoney")?.supportedMarkets).toContain("CN");
  });

  test("auto routes each market to capable sources in priority order", async () => {
    const settings = { "qubit-data": { klinesDataSource: "auto" } };
    const cn = await selectMarketDataSourcePlan({ market: "CN", timeframe: "1d", mode: "auto", settings });
    const us = await selectMarketDataSourcePlan({ market: "US", timeframe: "1d", mode: "auto", settings });
    const crypto = await selectMarketDataSourcePlan({ market: "CRYPTO", timeframe: "1d", mode: "auto", settings });
    expect(cn.slice(0, 2)).toEqual(["eastmoney", "akshare_tencent"]);
    expect(us).toEqual(["yfinance"]);
    expect(crypto).toEqual(["binance_crypto"]);
  });

  test("explicit source stays first but retains healthy fallback chain", async () => {
    const plan = await selectMarketDataSourcePlan({
      market: "US",
      timeframe: "1d",
      mode: "yahoo_chart",
      settings: { "qubit-data": { klinesDataSource: "yahoo_chart" } },
    });
    expect(plan).toEqual(["yahoo_chart"]);
  });

  test("explicit unavailable source falls back to healthy fallback chain", async () => {
    for (let i = 0; i < 3; i++) {
      await recordMarketDataSourceAttempt({
        sourceId: "yahoo_chart",
        market: "CN",
        timeframe: "1d",
        symbol: "600519",
        status: "error",
        error: "HTTP 403",
        latencyMs: 1,
      });
    }
    const plan = await selectMarketDataSourcePlan({
      market: "CN",
      timeframe: "1d",
      mode: "yahoo_chart",
      settings: { "qubit-data": { klinesDataSource: "yahoo_chart" } },
    });
    expect(plan.slice(0, 2)).toEqual(["eastmoney", "akshare_tencent"]);
  });

  test("does not treat wrappers on the same upstream as independent fallbacks", async () => {
    const cn = await selectMarketDataSourcePlan({
      market: "CN",
      timeframe: "1d",
      mode: "auto",
      settings: { "qubit-data": { klinesDataSource: "auto" } },
    });
    expect(cn).toContain("eastmoney");
    expect(cn).not.toContain("akshare");
    expect(cn).toContain("akshare_tencent");
  });

  test("shares rate-limit backoff across sources in the same upstream family", async () => {
    await recordMarketDataSourceAttempt({
      sourceId: "yfinance",
      market: "US",
      timeframe: "1d",
      symbol: "AAPL",
      status: "error",
      error: "HTTP 429 retry-after=60",
      latencyMs: 2,
    });
    const rows = await listMarketDataSources();
    expect(rows.find((row) => row.id === "yfinance")?.availabilityStatus).toBe("backing_off");
    expect(rows.find((row) => row.id === "yahoo_chart")?.availabilityStatus).toBe("backing_off");
    const plan = await selectMarketDataSourcePlan({
      market: "US",
      timeframe: "1d",
      mode: "auto",
      settings: { "qubit-data": { klinesDataSource: "auto" } },
    });
    expect(plan).toEqual([]);
  });
});
