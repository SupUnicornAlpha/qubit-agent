import { describe, expect, test } from "bun:test";
import { buildRequiredToolNextActionHint } from "../tools/required-tool-gate";
import { buildFocusedResearchScenarioPrompt } from "./focused-prompt";
import {
  REQUIRED_CAPABILITY_PRIMARY_TOOL,
  resolveRegistryScenarioKey,
} from "./scenario-key-aliases";
import { BUILTIN_RESEARCH_SCENARIOS } from "./scenarios-seed";

function builtinByKey(key: string) {
  return BUILTIN_RESEARCH_SCENARIOS.find((s) => s.key === key);
}

describe("scenario harness routing for bench recipe keys", () => {
  test("aliases map recipe keys to registry tool presets", () => {
    expect(resolveRegistryScenarioKey("stock_pick")).toBe("stock_screening");
    expect(resolveRegistryScenarioKey("factor")).toBe("factor_research");
    expect(resolveRegistryScenarioKey("strategy")).toBe("strategy_authoring");
    expect(resolveRegistryScenarioKey("live_trading")).toBe("live_trading");
  });

  test("registry presets expose primary write tools after alias resolution", () => {
    expect(builtinByKey("stock_screening")?.toolPreset?.builtinTools).toContain("run_screener");
    expect(builtinByKey("stock_screening")?.toolPreset?.builtinTools).toContain(
      "recommendation.record"
    );
    expect(builtinByKey("factor_research")?.toolPreset?.builtinTools).toContain("factor.register");
    expect(builtinByKey("strategy_authoring")?.toolPreset?.builtinTools).toContain(
      "strategy.create_version"
    );
    expect(builtinByKey("live_trading")?.toolPreset?.builtinTools).toContain("order.create_intent");
    expect(builtinByKey("live_trading")?.toolPreset?.builtinTools).toContain(
      "strategy.create_version"
    );
    expect(builtinByKey("live_trading")?.toolPreset?.builtinTools).toEqual([
      "strategy.create_version",
      "order.create_intent",
    ]);
    expect(builtinByKey("strategy_authoring")?.toolPreset?.builtinTools).toEqual([
      "strategy.create_version",
      "strategy.compose",
      "backtest.run",
      "strategy.compile",
      "strategy.contract_backtest",
      "strategy.paper_deploy",
      "strategy.sim_deploy",
    ]);
    expect(builtinByKey("live_trading")?.toolPreset?.builtinTools).not.toContain("evaluate_risk");
    expect(builtinByKey("live_trading")?.toolPreset?.builtinTools).not.toContain("rule.evaluate");
  });

  test("focused prompt applies to recipe keys, not only registry keys", () => {
    expect(buildFocusedResearchScenarioPrompt("stock_pick")).toContain("run_screener");
    expect(buildFocusedResearchScenarioPrompt("factor")).toContain("factor.register");
    expect(buildFocusedResearchScenarioPrompt("live_trading")).toContain("order.create_intent");
    expect(buildFocusedResearchScenarioPrompt("live_trading")).toContain("strategy.create_version");
    expect(buildFocusedResearchScenarioPrompt("strategy")).toMatch(
      /strategy\.compile|strategy\.create_version|def-strategy-coder/
    );
  });

  test("next-action hint points at primary contract tools", () => {
    const hint = buildRequiredToolNextActionHint({
      notAttempted: [
        {
          kind: "not_attempted",
          capability: "factor",
          market: "US",
          provider: null,
          reason: "x",
          retryable: true,
        },
      ],
    });
    const factorTool = REQUIRED_CAPABILITY_PRIMARY_TOOL.factor;
    expect(factorTool).toBeDefined();
    if (!factorTool) return;
    expect(hint).toContain(factorTool);
  });
});
