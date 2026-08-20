import type { HarnessToolSurfaceShadow } from "./shadow-tool-surface";

export type HarnessResolverRollout = {
  mode: "shadow" | "active";
  enabledProfileIds: string[];
  effectiveTools: string[];
  reason: string;
};

const COMPATIBILITY_TOOLS = new Set(["update_plan", "web.fetch", "web.search"]);

function normalize(items: readonly string[]): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))].sort();
}

/**
 * This is intentionally an explicit allowlist rather than a global boolean:
 * a profile only moves from shadow to active after its legacy/Harness diff has
 * been observed in production. The Harness side never expands the old surface.
 */
export function resolveHarnessResolverRollout(input: {
  shadow: HarnessToolSurfaceShadow;
  enabledProfilesRaw?: string | null;
}): HarnessResolverRollout {
  const enabledProfileIds = normalize((input.enabledProfilesRaw ?? "").split(","));
  const requiredProfiles = input.shadow.profileIds;
  const allProfilesEnabled =
    requiredProfiles.length > 0 &&
    requiredProfiles.every((profileId) => enabledProfileIds.includes(profileId));
  if (!allProfilesEnabled) {
    return {
      mode: "shadow",
      enabledProfileIds,
      effectiveTools: input.shadow.legacyTools,
      reason: requiredProfiles.length === 0 ? "no_harness_profile" : "profile_not_allowlisted",
    };
  }

  const compatibilityTools = input.shadow.legacyTools.filter((tool) =>
    COMPATIBILITY_TOOLS.has(tool)
  );
  return {
    mode: "active",
    enabledProfileIds,
    /**
     * Use only the legacy/Harness intersection plus universal control tools.
     * This is a restrictive, reversible rollout: a profile can never gain a
     * newly declared tool merely by turning the flag on.
     */
    effectiveTools: normalize([...input.shadow.sharedTools, ...compatibilityTools]),
    reason: "all_profiles_allowlisted",
  };
}

export function resolveHarnessResolverRolloutFromEnv(
  shadow: HarnessToolSurfaceShadow
): HarnessResolverRollout {
  const enabledProfilesRaw = process.env.QUBIT_HARNESS_RESOLVER_PROFILES;
  return resolveHarnessResolverRollout({
    shadow,
    ...(enabledProfilesRaw === undefined ? {} : { enabledProfilesRaw }),
  });
}
