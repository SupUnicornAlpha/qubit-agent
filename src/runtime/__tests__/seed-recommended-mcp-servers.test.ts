import { describe, expect, test } from "bun:test";
import {
  RECOMMENDED_MCP_NAMES,
  buildRecommendedMcpPresets,
  defaultQuantMcpServers,
} from "../seed-recommended-mcp-servers";

describe("recommended MCP defaults", () => {
  test("keeps unstable financex opt-in instead of assigning it to every quant agent", () => {
    const financex = buildRecommendedMcpPresets().find(
      (preset) => preset.name === RECOMMENDED_MCP_NAMES.FINANCEX
    );
    expect(financex?.defaultEnabled).toBe(false);
    expect(defaultQuantMcpServers()).not.toContain(RECOMMENDED_MCP_NAMES.FINANCEX);
  });

  test("publishes the actual TradingCalc tool namespace instead of inviting guessed tools", () => {
    const tradingcalc = buildRecommendedMcpPresets().find(
      (preset) => preset.name === RECOMMENDED_MCP_NAMES.TRADINGCALC
    );
    const tools = (tradingcalc?.capabilitiesJson?.tools ?? []) as Array<{ name?: string }>;
    expect(tools.map((tool) => tool.name)).toContain("workflow.run_pre_trade_check");
    expect(tools.map((tool) => tool.name)).not.toContain("get_stock_info");
  });
});
