import { beforeEach, describe, expect, test } from "bun:test";
import {
  evaluateToolGovernance,
  inferMarketScope,
  recordWorkflowToolFailure,
  resetToolGovernanceCacheForTest,
} from "./tool-governance-policy";

beforeEach(resetToolGovernanceCacheForTest);

describe("tool governance", () => {
  test("uses the shared resolver for suffix-less A-share symbols", () => {
    expect(inferMarketScope({ symbol: "600000" })).toBe("CN");
    expect(inferMarketScope({ symbol: "000001" })).toBe("CN");
    expect(inferMarketScope({ symbol: "AAPL" })).toBe("US");
    expect(inferMarketScope({ symbol: "BTCUSDT" })).toBe("CRYPTO");
  });
  test("infers CN and HK market suffixes", () => {
    expect(inferMarketScope({ symbol: "603986.SH" })).toBe("CN");
    expect(inferMarketScope({ symbols: ["00981.HK"] })).toBe("HK");
  });

  test("blocks US disclosure tools for CN symbols before execution", () => {
    const decision = evaluateToolGovernance({
      workflowId: "wf",
      targetName: "mcp-financex/get_8k_material_events",
      params: { symbol: "603986.SH" },
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("market_not_supported");
  });

  test("shares semantic no-data failures across agents in one workflow", () => {
    recordWorkflowToolFailure({
      workflowId: "wf",
      targetName: "qubit-news/fetch_news",
      params: { symbol: "603986.SH" },
      reason: "items_empty",
      cacheable: true,
    });
    const decision = evaluateToolGovernance({
      workflowId: "wf",
      targetName: "qubit-news/fetch_news_sentiment",
      params: { symbol: "603986.SH" },
    });
    expect(decision.allowed).toBe(false);
  });
});
