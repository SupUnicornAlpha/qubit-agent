/**
 * ToolSurfaceResolver — single entry for scenario tool-surface narrowing.
 */

import {
  applyMissingArtifactToolFilter,
  applyStallToolFilter,
} from "./tool-filters";
import type { ScenarioRuntimeSnapshot } from "./scenario-snapshot";
import type { ScenarioRecipe } from "./types";
import { toolMatchesRequiredCapability } from "../tools/data-gap";

const DEFAULT_STALL_TOOLS = [
  "market.readiness",
  "market.resolve_symbol",
  "market.data_sources",
  "factor.list",
  "update_plan",
  "run_screener",
  "evaluate_risk",
] as const;

export function applyToolSurface(input: {
  tools: readonly string[];
  snapshot: ScenarioRuntimeSnapshot;
  role?: string;
}): string[] {
  const { tools, snapshot, role } = input;
  if (!snapshot.scenarioKey) return [...tools];

  let next = [...tools];

  if (role === "orchestrator" && snapshot.recipe?.roleToolAllowlist?.orchestrator) {
    const allow = new Set(snapshot.recipe.roleToolAllowlist.orchestrator);
    next = next.filter((toolName) => {
      const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
      if (allow.has(toolName) || allow.has(base)) return true;
      if (base.startsWith("topology.") || base === "update_plan") return true;
      if (
        snapshot.notAttemptedCapabilities.some((capability) =>
          toolMatchesRequiredCapability(toolName, capability)
        )
      ) {
        return true;
      }
      return !isLikelyBusinessWrite(base);
    });
  }

  if (snapshot.notAttemptedCapabilities.length > 0) {
    next = applyStallToolFilter({
      tools: next,
      notAttemptedCapabilities: snapshot.notAttemptedCapabilities,
      attemptedTools: snapshot.attemptedTools,
    });
    if (
      snapshot.notAttemptedCapabilities.includes("factor") &&
      snapshot.factorDefinitionCount === 0
    ) {
      next = next.filter((toolName) => {
        const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
        return base === "factor.register" || toolName === "factor.register";
      });
    }
  } else if (!snapshot.artifactsOk && snapshot.attemptedTools.length > 0) {
    next = applyMissingArtifactToolFilter({
      tools: next,
      missingTables: snapshot.missingArtifactTables,
    });
  }

  // Once a factor has been persisted, registration is no longer a recovery
  // action for a missing evaluation.  Keeping it visible caused the factor
  // trace to create three near-identical definitions instead of computing /
  // evaluating the first one.
  if (
    snapshot.factorDefinitionCount > 0 &&
    snapshot.missingArtifactTables.includes("factor_evaluation")
  ) {
    const evaluationTools = new Set(["factor.compute", "factor.evaluate", "factor.autoEvaluate"]);
    const narrowed = next.filter((toolName) => {
      const parts = toolName.split("/");
      const base = parts[parts.length - 1] ?? toolName;
      return evaluationTools.has(toolName) || evaluationTools.has(base);
    });
    if (narrowed.length > 0) next = narrowed;
  }

  // Second-hop narrowing: after strategy version exists, prefer compose/order/backtest.
  if (snapshot.strategyVersionId) {
    const openOrder = snapshot.notAttemptedCapabilities.some((c) =>
      ["order", "risk", "order.create_intent"].includes(c)
    );
    const openStrategyCompose = snapshot.missingArtifactTables.includes("strategy_composition");
    if (openOrder || openStrategyCompose) {
      const prefer = new Set(
        openOrder
          ? ["order.create_intent", "strategy.compose", "evaluate_risk", "strategy.create_version"]
          : ["strategy.compose", "backtest.run", "run_backtest", "strategy.create_version"]
      );
      const narrowed = next.filter((toolName) => {
        const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
        return prefer.has(base) || prefer.has(toolName);
      });
      if (narrowed.length > 0) next = narrowed;
    }
  }

  next = applyStallBudgetStrip({
    tools: next,
    snapshot,
    recipe: snapshot.recipe,
  });

  return next.length > 0 ? next : [...tools];
}

function applyStallBudgetStrip(input: {
  tools: readonly string[];
  snapshot: ScenarioRuntimeSnapshot;
  recipe: ScenarioRecipe | null;
}): string[] {
  const budgetTools = new Set(input.recipe?.stallBudget.tools ?? DEFAULT_STALL_TOOLS);
  const maxSuccess = input.recipe?.stallBudget.maxSuccess ?? 1;
  const successCounts = countToolSuccesses(input.snapshot.successfulTools);
  return input.tools.filter((toolName) => {
    const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
    if (!budgetTools.has(base) && !budgetTools.has(toolName)) return true;
    const stillNeeded = input.snapshot.notAttemptedCapabilities.some((capability) =>
      toolMatchesRequiredCapability(toolName, capability)
    );
    if (stillNeeded) return true;
    // Cap repeated strategy.create_version once a version exists.
    if (
      (base === "strategy.create_version" || toolName === "strategy.create_version") &&
      input.snapshot.strategyVersionId
    ) {
      return false;
    }
    const count = successCounts.get(base) ?? successCounts.get(toolName) ?? 0;
    return count < maxSuccess;
  });
}

function countToolSuccesses(successfulTools: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const tool of successfulTools) {
    const base = tool.includes("/") ? tool.split("/").pop()! : tool;
    map.set(tool, (map.get(tool) ?? 0) + 1);
    map.set(base, (map.get(base) ?? 0) + 1);
  }
  return map;
}

function isLikelyBusinessWrite(base: string): boolean {
  return (
    base.startsWith("factor.") ||
    base.startsWith("strategy.") ||
    base.startsWith("order.") ||
    base === "recommendation.record" ||
    base === "run_screener" ||
    base === "backtest.run" ||
    base === "run_backtest"
  );
}
