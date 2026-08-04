import { describe, expect, test } from "bun:test";
import {
  buildResearchCanvasToolHits,
  classifyResearchCanvasToolName,
  extractMarketRefFromToolPayload,
  latestSuccessfulMarketLink,
} from "./researchCanvasToolLink";

describe("researchCanvasToolLink", () => {
  test("classifies market and news tools by name pattern", () => {
    expect(classifyResearchCanvasToolName("qubit-data/fetch_klines")).toBe("market");
    expect(classifyResearchCanvasToolName("fetch_quote")).toBe("market");
    expect(classifyResearchCanvasToolName("mcp-financex/fetch_news")).toBe("news");
    expect(classifyResearchCanvasToolName("assign_task")).toBe("other");
  });

  test("extracts symbol/exchange from nested params", () => {
    expect(
      extractMarketRefFromToolPayload({
        tool: "fetch_klines",
        params: { symbol: "NVDA", exchange: "US", limit: 120 },
      })
    ).toEqual({ symbol: "NVDA", exchange: "US" });

    expect(
      extractMarketRefFromToolPayload({
        arguments: { ticker: "600519", market: "SH" },
      })
    ).toEqual({ symbol: "600519", exchange: "SH" });
  });

  test("builds hits and picks latest successful market link", () => {
    const hits = buildResearchCanvasToolHits({
      toolCalls: [
        {
          id: "1",
          agentRole: "research",
          agentInstanceId: "i1",
          toolName: "fetch_klines",
          toolKind: "connector",
          status: "success",
          latencyMs: 80,
          createdAt: "2026-08-04T07:00:00.000Z",
          agentStepId: "s1",
          requestJson: { params: { symbol: "AAPL", exchange: "US" } },
          responseJson: { ok: true },
        },
        {
          id: "2",
          agentRole: "orchestrator",
          agentInstanceId: "i0",
          toolName: "update_plan",
          toolKind: "builtin",
          status: "success",
          latencyMs: 10,
          createdAt: "2026-08-04T07:01:00.000Z",
          agentStepId: "s2",
          requestJson: {},
        },
      ],
      mcpCalls: [
        {
          id: "m1",
          agentRole: "news_event",
          agentInstanceId: "i2",
          serverName: "news",
          toolName: "fetch_news",
          status: "success",
          latencyMs: 40,
          createdAt: "2026-08-04T07:02:00.000Z",
          requestJson: { params: { symbol: "AAPL" } },
          responseJson: { items: [] },
        },
      ],
    });

    expect(hits[0]?.toolName).toBe("news/fetch_news");
    expect(hits[0]?.kind).toBe("news");
    const link = latestSuccessfulMarketLink(hits);
    expect(link?.symbol).toBe("AAPL");
    expect(link?.kind).toBe("news");
  });
});
