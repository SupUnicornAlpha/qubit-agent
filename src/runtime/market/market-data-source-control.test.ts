import { beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/sqlite/migrate";
import {
  bootstrapMarketDataSources,
  listMarketDataSources,
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
      ["akshare", "binance_crypto", "eastmoney", "tushare_daily", "wind", "yahoo_chart", "yfinance"].sort()
    );
    expect(rows.find((row) => row.id === "tushare_daily")?.credentialsReady).toBe(false);
    expect(rows.find((row) => row.id === "eastmoney")?.supportedMarkets).toContain("CN");
  });

  test("auto routes each market to capable sources in priority order", async () => {
    const settings = { "qubit-data": { klinesDataSource: "auto" } };
    const cn = await selectMarketDataSourcePlan({ market: "CN", timeframe: "1d", mode: "auto", settings });
    const us = await selectMarketDataSourcePlan({ market: "US", timeframe: "1d", mode: "auto", settings });
    const crypto = await selectMarketDataSourcePlan({ market: "CRYPTO", timeframe: "1d", mode: "auto", settings });
    expect(cn.slice(0, 2)).toEqual(["eastmoney", "akshare"]);
    expect(us).toEqual(["yfinance", "yahoo_chart"]);
    expect(crypto).toEqual(["binance_crypto"]);
  });

  test("explicit source stays first but retains healthy fallback chain", async () => {
    const plan = await selectMarketDataSourcePlan({
      market: "US",
      timeframe: "1d",
      mode: "yahoo_chart",
      settings: { "qubit-data": { klinesDataSource: "yahoo_chart" } },
    });
    expect(plan).toEqual(["yahoo_chart", "yfinance"]);
  });
});
