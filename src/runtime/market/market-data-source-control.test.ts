import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/sqlite/migrate";
import {
  bootstrapMarketDataSources,
  listMarketDataSources,
  recordMarketDataSourceAttempt,
  resetMarketDataSourceRuntimeStateForTests,
  selectMarketDataSourcePlan,
} from "./market-data-source-control";

beforeAll(async () => {
  await runMigrations();
  await bootstrapMarketDataSources({ "qubit-data": { klinesDataSource: "auto" } });
});

beforeEach(async () => {
  await resetMarketDataSourceRuntimeStateForTests();
});

describe("market data source control plane", () => {
  test("registers all production source definitions with capabilities", async () => {
    const rows = await listMarketDataSources();
    const ids = rows.map((row) => row.id).sort();
    expect(ids).toContain("eastmoney");
    expect(ids).toContain("futu_bridge");
    expect(ids).toContain("yfinance");
    expect(rows.find((row) => row.id === "tushare_daily")?.credentialsReady).toBe(false);
    expect(rows.find((row) => row.id === "wind")?.credentialsReady).toBe(false);
    expect(rows.find((row) => row.id === "eastmoney")?.supportedMarkets).toContain("CN");
    expect(rows.find((row) => row.id === "eastmoney")?.feedClass).toBe("L0_research_fallback");
    expect(rows.find((row) => row.id === "eastmoney")?.licenseUse).toBe("research_only");
    expect(rows.find((row) => row.id === "binance_crypto")?.feedClass).toBe("L2_realtime_observe");
    expect(rows.find((row) => row.id === "wind")?.licenseUse).toBe("research_only");
    expect(rows.find((row) => row.id === "futu_bridge")?.upstreamFamily).toBe("futu");
  });

  test("auto routes each market to capable sources in priority order", async () => {
    const settings = { "qubit-data": { klinesDataSource: "auto" } };
    const cn = await selectMarketDataSourcePlan({ market: "CN", timeframe: "1d", mode: "auto", settings });
    const us = await selectMarketDataSourcePlan({ market: "US", timeframe: "1d", mode: "auto", settings });
    const crypto = await selectMarketDataSourcePlan({ market: "CRYPTO", timeframe: "1d", mode: "auto", settings });
    // Futu / IB / iFinD may lead when local credentials are present.
    const cnHead = cn.filter((id) =>
      ["futu_bridge", "supermind_bridge", "eastmoney", "akshare_tencent"].includes(id)
    );
    expect(cnHead).toContain("eastmoney");
    expect(cnHead).toContain("akshare_tencent");
    expect(cn.indexOf("eastmoney")).toBeLessThan(cn.indexOf("akshare_tencent"));
    if (cn.includes("supermind_bridge")) {
      expect(cn.indexOf("supermind_bridge")).toBeLessThan(cn.indexOf("eastmoney"));
    }
    if (cn.includes("futu_bridge") && !cn.includes("supermind_bridge")) {
      expect(cn.indexOf("futu_bridge")).toBeLessThan(cn.indexOf("eastmoney"));
    }

    const usAllowed = ["futu_bridge", "ib_bridge", "yfinance", "yahoo_chart"] as const;
    expect(us.every((id) => (usAllowed as readonly string[]).includes(id))).toBe(true);
    expect(us).toContain("yfinance");
    expect(us).toContain("yahoo_chart");
    expect(us.indexOf("yfinance")).toBeLessThan(us.indexOf("yahoo_chart"));
    expect(crypto).toEqual(["binance_crypto"]);
  });

  test("symbol-specific no-data does not trip the global source circuit", async () => {
    for (let i = 0; i < 4; i++) {
      await recordMarketDataSourceAttempt({
        // Do not share yfinance with the live-network API integration test:
        // Bun runs test files concurrently and its real failures are unrelated
        // to this no-data classification contract.
        sourceId: "futu_bridge",
        market: "CN",
        timeframe: "1d",
        symbol: `DELISTED${i}`,
        status: "empty",
        error: "no usable OHLCV rows",
        latencyMs: 1,
      });
    }
    const source = (await listMarketDataSources()).find((row) => row.id === "futu_bridge");
    expect(source?.circuitState).toBe("closed");
    expect(source?.healthStatus).toBe("unknown");
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
    if (plan[0] === "supermind_bridge") {
      expect(plan.slice(0, 3)).toContain("eastmoney");
      expect(plan).toContain("akshare_tencent");
    } else if (plan[0] === "futu_bridge") {
      expect(plan.slice(0, 3)).toEqual(["futu_bridge", "eastmoney", "akshare_tencent"]);
    } else {
      expect(plan.slice(0, 2)).toEqual(["eastmoney", "akshare_tencent"]);
    }
  });

  test("explicit source unsupported by the market falls back to a primary source", async () => {
    const plan = await selectMarketDataSourcePlan({
      market: "CRYPTO",
      timeframe: "1h",
      mode: "yahoo_chart",
      settings: { "qubit-data": { klinesDataSource: "yahoo_chart" } },
    });
    expect(plan).toEqual(["binance_crypto"]);
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
      sourceId: "eastmoney",
      market: "CN",
      timeframe: "1d",
      symbol: "600519",
      status: "error",
      error: "HTTP 429 retry-after=60",
      latencyMs: 2,
    });
    const rows = await listMarketDataSources();
    expect(rows.find((row) => row.id === "eastmoney")?.availabilityStatus).toBe("backing_off");
    expect(rows.find((row) => row.id === "akshare")?.availabilityStatus).toBe("backing_off");
    const plan = await selectMarketDataSourcePlan({
      market: "CN",
      timeframe: "1d",
      mode: "auto",
      settings: { "qubit-data": { klinesDataSource: "auto" } },
    });
    expect(plan).not.toContain("eastmoney");
    expect(plan).not.toContain("akshare");
    expect(plan).toContain("akshare_tencent");
  });

  test("prefers a proven healthy fallback over a higher-priority unknown source", async () => {
    // Ensure higher-priority peers are not already healthy from a sticky test DB.
    for (let i = 0; i < 3; i++) {
      await recordMarketDataSourceAttempt({
        sourceId: "eastmoney",
        market: "CN",
        timeframe: "1d",
        symbol: "600000",
        status: "error",
        error: "forced unhealthy for ranking test",
        latencyMs: 1,
      });
    }
    await recordMarketDataSourceAttempt({
      sourceId: "akshare_tencent",
      market: "CN",
      timeframe: "1d",
      symbol: "600000",
      status: "success",
      latencyMs: 1,
    });
    const plan = await selectMarketDataSourcePlan({
      market: "CN",
      timeframe: "1d",
      mode: "auto",
      settings: { "qubit-data": { klinesDataSource: "auto" } },
    });
    expect(plan[0]).toBe("akshare_tencent");
  });
});
