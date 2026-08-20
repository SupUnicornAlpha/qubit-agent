import { describe, expect, test } from "bun:test";
import { buildHarnessToolSurfaceShadow, selectHarnessShadowProfiles } from "./shadow-tool-surface";

describe("Harness tool surface shadow", () => {
  test("derives market, broker, option and developer overlays only from declared tools", () => {
    const profiles = selectHarnessShadowProfiles({
      role: "orchestrator",
      legacyTools: [
        "market.broker_quote.get",
        "fetch_option_chain",
        "shell.exec",
        "market.snapshot.get",
      ],
    });
    expect(profiles).toEqual([
      "broker-connected-research",
      "developer-assist",
      "financial-research",
      "us-options-research",
    ]);
  });

  test("compares legacy and Harness surfaces without changing either", () => {
    const shadow = buildHarnessToolSurfaceShadow({
      role: "research",
      legacyTools: ["fetch_klines", "market.snapshot.get", "custom.research_tool"],
    });

    expect(shadow.mode).toBe("shadow");
    expect(shadow.sharedTools).toEqual(["fetch_klines", "market.snapshot.get"]);
    expect(shadow.legacyOnlyTools).toContain("custom.research_tool");
    expect(shadow.harnessOnlyTools).toContain("market.ide_subscription.get");
    expect(shadow.legacyTools).toEqual([
      "custom.research_tool",
      "fetch_klines",
      "market.snapshot.get",
    ]);
  });

  test("leaves unrelated roles with no inferred profile", () => {
    const shadow = buildHarnessToolSurfaceShadow({ role: "risk", legacyTools: ["evaluate_risk"] });
    expect(shadow.profileIds).toEqual([]);
    expect(shadow.legacyOnlyTools).toEqual(["evaluate_risk"]);
  });
});
