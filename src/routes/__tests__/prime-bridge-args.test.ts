import { describe, expect, test } from "bun:test";
import {
  isBridgedLegacyToolName,
  normalizeBridgeToolArgs,
  normalizeInvestorAgentArgs,
  unwrapBridgeToolArgs,
} from "../../routes/prime-bridge.routes";

describe("unwrapBridgeToolArgs", () => {
  test("flattens nested arguments with top-level wins", () => {
    const out = unwrapBridgeToolArgs({
      arguments: {
        name: "nested",
        project_id: "proj-1",
        expr: "EMA(close,12)-EMA(close,26)",
      },
      name: "top",
    });
    expect(out.name).toBe("top");
    expect(out.project_id).toBe("proj-1");
    expect(out.projectId).toBe("proj-1");
    expect(out.expr).toBe("EMA(close,12)-EMA(close,26)");
    expect(out.arguments).toBeUndefined();
  });

  test("aliases strategyName and targets", () => {
    const out = unwrapBridgeToolArgs({
      arguments: {
        strategyName: "macd_long",
        targets: ["000001.SZ", "AAPL"],
        snapshot_id: "snap-1",
      },
    });
    expect(out.name).toBe("macd_long");
    expect(out.symbols).toEqual(["000001.SZ", "AAPL"]);
    expect(out.snapshotId).toBe("snap-1");
  });

  test("aliases bookId ticker allocation", () => {
    const out = unwrapBridgeToolArgs({
      arguments: {
        bookId: "fb_1",
        ticker: "ASTS",
        allocation: [{ symbol: "AAPL", weight: 0.5 }],
      },
    });
    expect(out.entryId).toBe("fb_1");
    expect(out.symbol).toBe("ASTS");
    expect(out.ticker).toBe("ASTS");
    expect(out.candidates).toEqual([{ symbol: "AAPL", weight: 0.5 }]);
  });

  test("flattens params and args nesting used by OpenAI-compatible tool calls", () => {
    expect(unwrapBridgeToolArgs({ params: { factor_id: "f-1", symbols: ["AAPL"] } })).toMatchObject(
      {
        factor_id: "f-1",
        symbols: ["AAPL"],
      }
    );
    expect(unwrapBridgeToolArgs({ args: { strategy_version_id: "sv-1" } })).toMatchObject({
      strategy_version_id: "sv-1",
    });
  });
});

describe("isBridgedLegacyToolName", () => {
  test("allows static builtins and dynamic call_team_*", () => {
    expect(isBridgedLegacyToolName("market.snapshot.get")).toBe(true);
    expect(isBridgedLegacyToolName("assign_task")).toBe(false);
    expect(isBridgedLegacyToolName("call_team_research")).toBe(true);
    expect(isBridgedLegacyToolName("call_team_news_event")).toBe(true);
    expect(isBridgedLegacyToolName("fetch_news")).toBe(true);
    expect(isBridgedLegacyToolName("fetch_news_sentiment")).toBe(true);
    expect(isBridgedLegacyToolName("fetch_fundamentals")).toBe(true);
    expect(isBridgedLegacyToolName("fetch_financial_data")).toBe(false);
    expect(isBridgedLegacyToolName("compute_valuation")).toBe(true);
    expect(isBridgedLegacyToolName("fetch_klines")).toBe(true);
    expect(isBridgedLegacyToolName("compute_indicators")).toBe(true);
    expect(isBridgedLegacyToolName("not_a_real_tool")).toBe(false);
  });
});

describe("normalizeInvestorAgentArgs", () => {
  test("fills required modules for get_stock_info when missing", () => {
    const out = normalizeInvestorAgentArgs("investor-agent", "get_stock_info", {
      symbol: "603986.SS",
    });
    expect(out.symbol).toBe("603986.SS");
    expect(out.ticker).toBe("603986.SS");
    expect(Array.isArray(out.modules)).toBe(true);
    expect((out.modules as string[]).length).toBeGreaterThan(0);
  });

  test("leaves unrelated MCP tools untouched", () => {
    const args = { expression: "1+1" };
    expect(normalizeInvestorAgentArgs("mathjs", "evaluate", args)).toEqual(args);
  });

  test("normalizes Yahoo A-share symbols and technical indicator case", () => {
    expect(
      normalizeInvestorAgentArgs("investor-agent", "technical_indicator", {
        symbol: "603986.SH",
        indicator: "rsi",
      })
    ).toMatchObject({ symbol: "603986.SS", ticker: "603986.SS", indicator: "RSI" });
    expect(
      normalizeInvestorAgentArgs("investor-agent", "historical_prices", {
        ticker: "603986",
      })
    ).toMatchObject({ symbol: "603986.SS", ticker: "603986.SS" });
  });
});

describe("normalizeBridgeToolArgs", () => {
  test("maps model-friendly news aliases to connector arrays", () => {
    expect(
      normalizeBridgeToolArgs("fetch_news", {
        symbol: "603986.SH",
        query: "兆易创新 公告",
      })
    ).toMatchObject({
      symbols: ["603986.SH"],
      keywords: ["兆易创新 公告"],
    });
  });

  test("maps a URL passed as web.fetch query to url", () => {
    expect(normalizeBridgeToolArgs("web.fetch", { query: "https://example.com/a" })).toMatchObject({
      url: "https://example.com/a",
    });
  });

  test("canonicalizes compact date aliases for quant tools", () => {
    expect(
      normalizeBridgeToolArgs("factor.compute", {
        start: "2024-01-01",
        end: "2024-12-31",
      })
    ).toMatchObject({ start_date: "2024-01-01", end_date: "2024-12-31" });
  });
});
