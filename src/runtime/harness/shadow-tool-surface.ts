import { resolveToolAlias } from "../tools/tool-catalog";
import type { RuntimeAgentDefinition } from "../types";
import { createBuiltinFinancialHarnessRegistry } from "./builtin-financial-capabilities";
import { isHarnessProfileCircuitOpen, recordHarnessProfileFailure } from "./health";
import { getActiveHarnessPackageProfiles } from "./package-manager";
import type { ResolvedCapabilityComposition } from "./types";

export type HarnessToolSurfaceShadow = {
  mode: "shadow";
  profileIds: string[];
  /** Profiles deliberately omitted after a failed third-party composition. */
  unavailableProfileIds: string[];
  availabilityWarning: string | null;
  capabilityIds: string[];
  legacyTools: string[];
  harnessTools: string[];
  sharedTools: string[];
  legacyOnlyTools: string[];
  harnessOnlyTools: string[];
};

function canonicalize(tools: readonly string[]): string[] {
  return [
    ...new Set(tools.map((tool) => resolveToolAlias(tool.trim()).resolved).filter(Boolean)),
  ].sort();
}

function hasAny(tools: readonly string[], candidates: readonly string[]): boolean {
  const toolSet = new Set(tools);
  return candidates.some((candidate) => toolSet.has(candidate));
}

/**
 * This deliberately infers a profile from declared agent tools only. It never
 * uses conversational memory or makes a provider call while assembling a
 * prompt-facing surface.
 */
export function selectHarnessShadowProfiles(input: {
  role: RuntimeAgentDefinition["role"];
  legacyTools: readonly string[];
}): string[] {
  const tools = canonicalize(input.legacyTools);
  const profiles: string[] = [];
  const hasMarketTool =
    input.role === "orchestrator" ||
    /market|analyst|research/.test(input.role) ||
    hasAny(tools, [
      "fetch_klines",
      "fetch_quote",
      "fetch_ticks",
      "fetch_fundamentals",
      "fetch_news",
      "market.snapshot.get",
    ]);
  if (hasMarketTool) profiles.push("financial-research");
  if (hasAny(tools, ["market.broker_quote.get"])) profiles.push("broker-connected-research");
  if (hasAny(tools, ["fetch_option_chain"])) profiles.push("us-options-research");
  if (hasAny(tools, ["run_backtest", "backtest.run"])) profiles.push("paper-trading");
  if (hasAny(tools, ["math.derivation.verify"])) profiles.push("math-audit");
  if (hasAny(tools, ["shell.exec", "cli_agent.run"])) profiles.push("developer-assist");
  return [...new Set([...profiles, ...getActiveHarnessPackageProfiles()])].sort();
}

/**
 * Phase 2 shadow resolver: pure, deterministic and intentionally non-binding.
 * Callers continue to use `legacyTools`; the comparison is carried alongside
 * the effective result for trace/ledger projection in the next phase.
 */
export function buildHarnessToolSurfaceShadow(input: {
  role: RuntimeAgentDefinition["role"];
  legacyTools: readonly string[];
}): HarnessToolSurfaceShadow {
  const legacyTools = canonicalize(input.legacyTools);
  const requestedProfileIds = selectHarnessShadowProfiles(input);
  const circuitOpenProfileIds = requestedProfileIds.filter((profileId) =>
    isHarnessProfileCircuitOpen(profileId)
  );
  const profileIds = requestedProfileIds.filter(
    (profileId) => !circuitOpenProfileIds.includes(profileId)
  );
  if (profileIds.length === 0) {
    return {
      mode: "shadow",
      profileIds: [],
      unavailableProfileIds: circuitOpenProfileIds,
      availabilityWarning:
        circuitOpenProfileIds.length > 0
          ? `Harness circuit open: ${circuitOpenProfileIds.join(", ")}`
          : null,
      capabilityIds: [],
      legacyTools,
      harnessTools: [],
      sharedTools: [],
      legacyOnlyTools: legacyTools,
      harnessOnlyTools: [],
    };
  }
  const registry = createBuiltinFinancialHarnessRegistry();
  let resolvedProfileIds = profileIds;
  let unavailableProfileIds: string[] = [...circuitOpenProfileIds];
  let availabilityWarning: string | null =
    circuitOpenProfileIds.length > 0
      ? `Harness circuit open: ${circuitOpenProfileIds.join(", ")}`
      : null;
  let composition: ResolvedCapabilityComposition;
  try {
    composition = registry.resolveProfiles(resolvedProfileIds);
  } catch (error) {
    // Installed packages are never allowed to make an Agent unavailable. Drop
    // every externally activated profile as one conservative unit and retain
    // the deterministic built-in/legacy path. If a built-in profile itself is
    // invalid, fall all the way back to the old surface instead of throwing.
    const packageProfiles = new Set(getActiveHarnessPackageProfiles());
    unavailableProfileIds = resolvedProfileIds.filter((profileId) =>
      packageProfiles.has(profileId)
    );
    unavailableProfileIds = [...new Set([...circuitOpenProfileIds, ...unavailableProfileIds])];
    resolvedProfileIds = resolvedProfileIds.filter((profileId) => !packageProfiles.has(profileId));
    const degradationError = error instanceof Error ? error.message : String(error);
    recordHarnessProfileFailure(
      unavailableProfileIds.filter((profileId) => packageProfiles.has(profileId)),
      degradationError
    );
    availabilityWarning = `${availabilityWarning ? `${availabilityWarning}; ` : ""}Harness composition degraded: ${degradationError}`;
    if (resolvedProfileIds.length === 0) {
      return {
        mode: "shadow",
        profileIds: [],
        unavailableProfileIds,
        availabilityWarning,
        capabilityIds: [],
        legacyTools,
        harnessTools: [],
        sharedTools: [],
        legacyOnlyTools: legacyTools,
        harnessOnlyTools: [],
      };
    }
    try {
      composition = registry.resolveProfiles(resolvedProfileIds);
    } catch (fallbackError) {
      return {
        mode: "shadow",
        profileIds: [],
        unavailableProfileIds,
        availabilityWarning: `${availabilityWarning}; fallback failed: ${
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        }`,
        capabilityIds: [],
        legacyTools,
        harnessTools: [],
        sharedTools: [],
        legacyOnlyTools: legacyTools,
        harnessOnlyTools: [],
      };
    }
  }
  const harnessTools = canonicalize(composition.tools.map((tool) => tool.name));
  const harnessSet = new Set(harnessTools);
  const legacySet = new Set(legacyTools);
  return {
    mode: "shadow",
    profileIds: resolvedProfileIds,
    unavailableProfileIds,
    availabilityWarning,
    capabilityIds: composition.capabilityIds,
    legacyTools,
    harnessTools,
    sharedTools: legacyTools.filter((tool) => harnessSet.has(tool)),
    legacyOnlyTools: legacyTools.filter((tool) => !harnessSet.has(tool)),
    harnessOnlyTools: harnessTools.filter((tool) => !legacySet.has(tool)),
  };
}
