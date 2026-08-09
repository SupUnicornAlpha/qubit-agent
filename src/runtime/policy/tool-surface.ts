/**
 * ToolSurfaceResolver — single entry for scenario tool-surface narrowing.
 */

import { applyMissingArtifactToolFilter, applyStallToolFilter } from "./tool-filters";
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
  "fetch_klines",
  "fetch_quote",
  "fetch_bars",
  "fetch_price_data",
  "web.fetch",
  "web.search",
  "fetch_news",
  "fetch_news_sentiment",
  "mcp:mathjs:evaluate",
  "mcp:investor-agent:historical_prices",
  "mcp:investor-agent:technical_indicator",
  "mcp:investor-agent:get_stock_info",
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
  } else if (!snapshot.researchArtifactsOk && snapshot.attemptedTools.length > 0) {
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
    !snapshot.researchArtifactsOk &&
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

  // Research second hop: after quote evidence, force news before more klines.
  // Specialists without fetch_news must not fall back to an unbounded kline surface —
  // strip quote tools so they finish writing, while news_event / orchestrator can fill news.
  if (
    (snapshot.scenarioKey === "research" ||
      snapshot.scenarioKey === "research_multi" ||
      snapshot.scenarioKey === "research_theme" ||
      snapshot.recipe?.key === "research") &&
    snapshot.attemptedTools.some((t) => {
      const base = t.includes("/") ? t.split("/").pop()! : t;
      return base === "fetch_klines" || base === "fetch_quote" || base === "fetch_bars";
    }) &&
    snapshot.notAttemptedCapabilities.includes("news")
  ) {
    const prefer = new Set(["fetch_news", "fetch_news_sentiment"]);
    const narrowed = next.filter((toolName) => {
      const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
      return prefer.has(base) || prefer.has(toolName);
    });
    if (narrowed.length > 0) {
      next = narrowed;
    } else {
      // Stall filter may have emptied `next` (specialist lacks news tools).
      // Strip quote churn from the authorized input surface instead.
      const source = next.length > 0 ? next : [...tools];
      next = source.filter((toolName) => {
        const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
        return (
          base !== "fetch_klines" &&
          base !== "fetch_quote" &&
          base !== "fetch_bars" &&
          base !== "fetch_price_data" &&
          base !== "market.readiness" &&
          base !== "market.resolve_symbol" &&
          base !== "market.data_sources"
        );
      });
    }
  }

  // Stock-pick second hop: after screener, prefer quote + recommendation until research floor filled.
  // Keep fetch_klines so B-1 get_quote can still land (narrowing to record-only blocked quote).
  if (
    (snapshot.scenarioKey === "stock_pick" ||
      snapshot.scenarioKey === "stock_pick_short" ||
      snapshot.recipe?.key === "stock_pick" ||
      snapshot.notAttemptedCapabilities.includes("recommendation.record")) &&
    snapshot.attemptedTools.some((t) => t === "run_screener" || t.endsWith("/run_screener")) &&
    !snapshot.researchArtifactsOk &&
    (snapshot.missingArtifactTables.includes("recommendation_snapshot") || !snapshot.artifactsOk)
  ) {
    const prefer = new Set(["recommendation.record", "fetch_klines", "fetch_bars", "get_quote"]);
    const narrowed = next.filter((toolName) => {
      const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
      return prefer.has(base) || prefer.has(toolName);
    });
    if (narrowed.length > 0) next = narrowed;
  }

  const isLive = snapshot.scenarioKey === "live_trading" || snapshot.recipe?.key === "live_trading";
  const isStrategy = snapshot.scenarioKey === "strategy" || snapshot.recipe?.key === "strategy";

  // Live trading: strip broker submit / standalone risk probes until order_intent exists.
  // rule.evaluate looks like "risk" for B-1 aliases but does not write risk_decision for an intent.
  if (isLive && snapshot.missingArtifactTables.includes("order_intent")) {
    next = next.filter((toolName) => {
      const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
      return (
        base !== "submit_order" &&
        !toolName.endsWith("/submit_order") &&
        base !== "evaluate_risk" &&
        !toolName.endsWith("/evaluate_risk") &&
        base !== "rule.evaluate" &&
        !toolName.endsWith("/rule.evaluate")
      );
    });
  }

  // Live trading: never advertise order before a strategy version exists.
  if (isLive && !snapshot.strategyVersionId) {
    next = next.filter((toolName) => {
      const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
      return base !== "order.create_intent" && toolName !== "order.create_intent";
    });
  }

  // Second-hop narrowing: after strategy version exists, prefer compose/order/backtest.
  if (snapshot.strategyVersionId) {
    const openOrder =
      isLive &&
      (snapshot.missingArtifactTables.includes("order_intent") ||
        snapshot.notAttemptedCapabilities.some((c) =>
          ["order", "risk", "order.create_intent"].includes(c)
        ));
    const openStrategyCompose =
      isStrategy && snapshot.missingArtifactTables.includes("strategy_composition");
    if (openOrder) {
      const prefer = new Set(["order.create_intent"]);
      const narrowed = next.filter((toolName) => {
        const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
        return prefer.has(base) || prefer.has(toolName);
      });
      if (narrowed.length > 0) next = narrowed;
    } else if (openStrategyCompose) {
      const prefer = new Set(["strategy.compose", "backtest.run"]);
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

  // Never undo intentional surface narrowing by restoring the full authorized
  // set — an empty (or nearly empty) next surface is preferable to re-enabling
  // stall tools that just exhausted their budget.
  if (next.length > 0) return next;
  const strippedStall = tools.filter((toolName) => {
    const base = toolName.includes("/") ? toolName.split("/").pop()! : toolName;
    const budgetTools = new Set(snapshot.recipe?.stallBudget.tools ?? DEFAULT_STALL_TOOLS);
    return !budgetTools.has(base) && !budgetTools.has(toolName);
  });
  return strippedStall.length > 0 ? strippedStall : [];
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
    base === "backtest.run"
  );
}
