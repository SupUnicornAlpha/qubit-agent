/**
 * financex-fallback.test.ts (P0-2 Round 6 复盘修)
 *
 * 验证 mcp-financex fallback router 的核心契约：
 *   - 白名单工具 (get_quote / get_quote_batch / get_historical_data / get_market_news)
 *     可以在 financex 不可用时路由到 qubit-data / qubit-news connector
 *   - 非白名单工具 (如 get_options_chain) 必须返回 null（让 caller 抛原始错）
 *   - 非 financex server 必须返回 null（不能误伤其他 MCP）
 *   - 返回 shape 携带 __mcp_fallback 元数据，方便上层日志 / eval 识别
 *
 * 用 mock 替代 queryBarsRange / queryMarketNewsBrief，避免真实拉 Yahoo（不稳定）。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { tryFinancexFallback, FINANCEX_FALLBACK_TOOLS } from "../financex-fallback";

/** 通过 mock.module 替换底层数据源 */
const originalEnv = process.env;

beforeAll(() => {
  /** 不需要 db 也不需要真实 Yahoo —— 直接 mock 两个函数 */
});

afterAll(() => {
  process.env = originalEnv;
});

describe("tryFinancexFallback router 守门 (P0-2)", () => {
  test("非 mcp-financex server → 返回 null（不误伤其他 MCP）", async () => {
    const r = await tryFinancexFallback({
      serverName: "other-mcp",
      toolName: "get_quote",
      arguments: { symbol: "AAPL" },
      reason: "circuit_open",
    });
    expect(r).toBeNull();
  });

  test("financex 工具不在白名单 → 返回 null（如 get_options_chain）", async () => {
    const r = await tryFinancexFallback({
      serverName: "mcp-financex",
      toolName: "get_options_chain",
      arguments: { symbol: "AAPL" },
      reason: "tool_error",
    });
    expect(r).toBeNull();
  });

  test("白名单集合覆盖 Round 6 trace 中所有 financex 热路径工具", () => {
    expect(FINANCEX_FALLBACK_TOOLS.has("get_quote")).toBe(true);
    expect(FINANCEX_FALLBACK_TOOLS.has("get_quote_batch")).toBe(true);
    expect(FINANCEX_FALLBACK_TOOLS.has("get_historical_data")).toBe(true);
    expect(FINANCEX_FALLBACK_TOOLS.has("get_market_news")).toBe(true);
  });

  test("get_quote 缺 symbol → 抛清晰错误", async () => {
    await expect(
      tryFinancexFallback({
        serverName: "mcp-financex",
        toolName: "get_quote",
        arguments: {},
        reason: "tool_error",
      })
    ).rejects.toThrow(/symbol \/ ticker \/ symbols \/ tickers/);
  });

  test("get_historical_data 缺 symbol → 抛清晰错误", async () => {
    await expect(
      tryFinancexFallback({
        serverName: "mcp-financex",
        toolName: "get_historical_data",
        arguments: {},
        reason: "circuit_open",
      })
    ).rejects.toThrow(/必须传 symbol/);
  });
});

describe("tryFinancexFallback 数据路径 (mock queryBarsRange)", () => {
  /** 用 bun:test mock.module 替换 queryBarsRange / queryMarketNewsBrief 避免拉真实 Yahoo */
  let mockBarsCalled = false;
  let mockNewsCalled = false;

  beforeAll(() => {
    mock.module("../../market/klines-query", () => ({
      queryBarsRange: async (params: { symbol: string; startDate: string; endDate: string }) => {
        mockBarsCalled = true;
        if (params.symbol === "EMPTY") return [];
        if (params.symbol === "BOOM") throw new Error("yahoo 403");
        return [
          {
            timestamp: "2026-06-05T00:00:00.000Z",
            open: 100,
            high: 105,
            low: 99,
            close: 102.5,
            volume: 1_000_000,
          },
          {
            timestamp: "2026-06-06T00:00:00.000Z",
            open: 102,
            high: 106,
            low: 101,
            close: 104.0,
            volume: 1_200_000,
          },
        ];
      },
    }));
    mock.module("../../market/news-brief-query", () => ({
      queryMarketNewsBrief: async (params: { symbol: string }) => {
        mockNewsCalled = true;
        if (params.symbol === "EMPTY") {
          return { sectorLabel: null, sectorHeadlineTicker: null, symbolNews: [], sectorNews: [] };
        }
        return {
          sectorLabel: "Technology",
          sectorHeadlineTicker: "XLK",
          symbolNews: [
            {
              id: "n1",
              title: "AAPL beats earnings",
              content: "Apple reported strong Q2 earnings...",
              publishedAt: "2026-06-05T12:00:00.000Z",
              source: "Reuters",
              url: "https://reuters.com/aapl1",
            },
          ],
          sectorNews: [],
        };
      },
    }));
  });

  test("get_quote 单 symbol → 返回最近一根 K 线 + __mcp_fallback 元数据", async () => {
    const r = await tryFinancexFallback({
      serverName: "mcp-financex",
      toolName: "get_quote",
      arguments: { symbol: "AAPL" },
      reason: "circuit_open",
      originalError: new Error("circuit open"),
    });
    expect(r).not.toBeNull();
    const out = r!.output as Record<string, unknown>;
    expect(out["symbol"]).toBe("AAPL");
    expect(out["price"]).toBe(104.0); // latest close
    expect(out["bar_date"]).toBe("2026-06-06");
    expect(mockBarsCalled).toBe(true);
    expect(out["__mcp_fallback"]).toMatchObject({
      original_server: "mcp-financex",
      original_tool: "get_quote",
      reason: "circuit_open",
      routed_to: "qubit-data",
    });
  });

  test("get_quote_batch 多 symbols → 返回 quotes 数组", async () => {
    const r = await tryFinancexFallback({
      serverName: "mcp-financex",
      toolName: "get_quote_batch",
      arguments: { symbols: ["AAPL", "MSFT"] },
      reason: "tool_error",
    });
    expect(r).not.toBeNull();
    const out = r!.output as { quotes: Array<{ symbol: string; price: number }>; count: number };
    expect(Array.isArray(out.quotes)).toBe(true);
    expect(out.count).toBe(2);
    expect(out.quotes[0]!.symbol).toBe("AAPL");
    expect(out.quotes[1]!.symbol).toBe("MSFT");
  });

  test("get_quote 单 symbol 拉不到 K 线 → 返回 error 字段而非抛错", async () => {
    const r = await tryFinancexFallback({
      serverName: "mcp-financex",
      toolName: "get_quote",
      arguments: { symbol: "EMPTY" },
      reason: "circuit_open",
    });
    expect(r).not.toBeNull();
    const out = r!.output as { error?: string };
    expect(out.error).toBe("no_bars");
  });

  test("get_quote 单 symbol queryBars 抛错 → 在结果里 error 字段透传（不让整调用挂掉）", async () => {
    const r = await tryFinancexFallback({
      serverName: "mcp-financex",
      toolName: "get_quote",
      arguments: { symbol: "BOOM" },
      reason: "tool_error",
    });
    expect(r).not.toBeNull();
    const out = r!.output as { error?: string };
    expect(out.error).toMatch(/yahoo 403/);
  });

  test("get_historical_data → 返回 bars 数组 + count + 警告 non-daily", async () => {
    const r = await tryFinancexFallback({
      serverName: "mcp-financex",
      toolName: "get_historical_data",
      arguments: {
        symbol: "AAPL",
        start_date: "2026-01-01",
        end_date: "2026-06-30",
        interval: "1h",
      },
      reason: "tool_error",
    });
    expect(r).not.toBeNull();
    const out = r!.output as {
      symbol: string;
      bars: Array<{ close: number }>;
      count: number;
      warning?: string;
    };
    expect(out.symbol).toBe("AAPL");
    expect(out.bars).toHaveLength(2);
    expect(out.count).toBe(2);
    expect(out.warning).toMatch(/only supports daily/);
  });

  test("get_market_news → 返回 headlines + sector", async () => {
    const r = await tryFinancexFallback({
      serverName: "mcp-financex",
      toolName: "get_market_news",
      arguments: { symbol: "AAPL", limit: 5 },
      reason: "tool_error",
    });
    expect(r).not.toBeNull();
    const out = r!.output as {
      symbol: string;
      headlines: Array<{ headline: string; source: string | null }>;
      sector: string | null;
    };
    expect(out.symbol).toBe("AAPL");
    expect(out.headlines.length).toBeGreaterThan(0);
    expect(out.headlines[0]!.headline).toMatch(/AAPL beats/);
    expect(out.sector).toBe("Technology");
    expect(mockNewsCalled).toBe(true);
  });
});
