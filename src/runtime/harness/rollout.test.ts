import { describe, expect, test } from "bun:test";
import { resolveHarnessResolverRollout } from "./rollout";
import type { HarnessToolSurfaceShadow } from "./shadow-tool-surface";

function shadow(overrides: Partial<HarnessToolSurfaceShadow> = {}): HarnessToolSurfaceShadow {
  return {
    mode: "shadow",
    profileIds: ["financial-research"],
    unavailableProfileIds: [],
    availabilityWarning: null,
    capabilityIds: ["market.core", "research.core"],
    legacyTools: ["fetch_klines", "market.snapshot.get", "update_plan", "web.search"],
    harnessTools: ["fetch_klines", "market.snapshot.get"],
    sharedTools: ["fetch_klines", "market.snapshot.get"],
    legacyOnlyTools: ["update_plan", "web.search"],
    harnessOnlyTools: [],
    ...overrides,
  };
}

describe("Harness resolver rollout", () => {
  test("stays in shadow mode by default", () => {
    const result = resolveHarnessResolverRollout({ shadow: shadow() });
    expect(result.mode).toBe("shadow");
    expect(result.effectiveTools).toEqual(shadow().legacyTools);
  });

  test("requires every derived profile to be explicitly allowlisted", () => {
    const result = resolveHarnessResolverRollout({
      shadow: shadow({ profileIds: ["financial-research", "us-options-research"] }),
      enabledProfilesRaw: "financial-research",
    });
    expect(result.mode).toBe("shadow");
    expect(result.reason).toBe("profile_not_allowlisted");
  });

  test("uses a non-expanding Harness intersection after opt-in", () => {
    const result = resolveHarnessResolverRollout({
      shadow: shadow(),
      enabledProfilesRaw: "financial-research",
    });
    expect(result).toMatchObject({ mode: "active", reason: "all_profiles_allowlisted" });
    expect(result.effectiveTools).toEqual([
      "fetch_klines",
      "market.snapshot.get",
      "update_plan",
      "web.search",
    ]);
  });
});
