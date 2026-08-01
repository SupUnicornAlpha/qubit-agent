import { describe, expect, test } from "bun:test";
import { buildFocusedResearchScenarioPrompt } from "../react/nodes/reason";
import {
  resolveRegistryScenarioKey,
  REQUIRED_CAPABILITY_PRIMARY_TOOL,
} from "./scenario-key-aliases";
import { BUILTIN_RESEARCH_SCENARIOS } from "./scenarios-seed";
import { buildRequiredToolNextActionHint } from "../tools/required-tool-gate";

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
    expect(builtinByKey("live_trading")?.toolPreset?.builtinTools).toContain("evaluate_risk");
  });

  test("focused prompt applies to recipe keys, not only registry keys", () => {
    expect(buildFocusedResearchScenarioPrompt("stock_pick")).toContain("run_screener");
    expect(buildFocusedResearchScenarioPrompt("factor")).toContain("factor.register");
    expect(buildFocusedResearchScenarioPrompt("live_trading")).toContain("order.create_intent");
    expect(buildFocusedResearchScenarioPrompt("live_trading")).toContain("strategy.create_version");
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
    expect(hint).toContain(REQUIRED_CAPABILITY_PRIMARY_TOOL.factor!);
  });
});
