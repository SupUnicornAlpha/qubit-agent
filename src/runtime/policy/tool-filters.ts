/**
 * Pure tool-surface filters (moved out of orchestration to break policy→orchestration cycle).
 */

import { toolMatchesRequiredCapability } from "../tools/data-gap";
import { resolveToolAlias } from "../tools/tool-catalog";

export const CONTRACT_TOOL_PREREQUISITES: Record<string, readonly string[]> = {
  order: ["strategy.create_version"],
  risk: ["strategy.create_version", "order.create_intent"],
  strategy: ["factor.list"],
  factor: ["factor.list"],
  "recommendation.record": ["run_screener"],
  screener: [],
};

export const MISSING_ARTIFACT_TOOL_HINTS: Record<string, readonly string[]> = {
  factor_definition: ["factor.register"],
  factor_evaluation: ["factor.evaluate", "factor.compute", "factor.autoEvaluate", "factor.register"],
  screener_candidate: ["run_screener"],
  recommendation_snapshot: ["recommendation.record"],
  strategy_version: ["strategy.create_version"],
  strategy_composition: ["strategy.compose"],
  "quality:strategy_backtest_completed": ["backtest.run", "run_backtest"],
  order_intent: ["order.create_intent"],
  risk_decision: ["order.create_intent", "evaluate_risk"],
};

export function normalizeToolNames(names: string[]): string[] {
  return [...new Set(names.map((n) => resolveToolAlias(n.trim()).resolved).filter(Boolean))];
}

export function applyStallToolFilter(input: {
  tools: readonly string[];
  notAttemptedCapabilities: readonly string[];
  attemptedTools: readonly string[];
}): string[] {
  if (input.notAttemptedCapabilities.length === 0) return [...input.tools];
  if (input.attemptedTools.length === 0) return [...input.tools];

  const attempted = new Set(
    input.attemptedTools.flatMap((toolName) => {
      const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
      return [toolName, base];
    })
  );

  const prereqAllow = new Set<string>();
  for (const capability of input.notAttemptedCapabilities) {
    for (const prereq of CONTRACT_TOOL_PREREQUISITES[capability] ?? []) {
      if (!attempted.has(prereq)) prereqAllow.add(prereq);
    }
  }

  return input.tools.filter((toolName) => {
    const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
    if (
      input.notAttemptedCapabilities.some((capability) =>
        toolMatchesRequiredCapability(toolName, capability)
      )
    ) {
      return true;
    }
    if (prereqAllow.has(base) || prereqAllow.has(toolName)) return true;
    return false;
  });
}

export function applyMissingArtifactToolFilter(input: {
  tools: readonly string[];
  missingTables: readonly string[];
}): string[] {
  if (input.missingTables.length === 0) return [...input.tools];
  const allowed = new Set<string>();
  for (const table of input.missingTables) {
    for (const tool of MISSING_ARTIFACT_TOOL_HINTS[table] ?? []) {
      allowed.add(tool);
    }
  }
  if (allowed.size === 0) return [...input.tools];
  const filtered = input.tools.filter((toolName) => {
    const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
    return allowed.has(base) || allowed.has(toolName);
  });
  return filtered.length > 0 ? filtered : [...input.tools];
}
