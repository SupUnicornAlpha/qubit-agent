/** @deprecated Prefer resolveScenarioRecipe / listLoadedRecipes — JSON is the source of truth. */
import { resolveScenarioRecipe } from "../scenario-recipe";
import type { ScenarioRecipe } from "../types";

export const liveTradingRecipe: ScenarioRecipe =
  resolveScenarioRecipe("live_trading") ??
  ({
    key: "live_trading",
    aliases: [],
    version: "missing",
    stallBudget: { tools: [], key: "tool_fingerprint", maxSuccess: 1, onExceed: "strip_from_surface" },
    recovery: { afterProbeFailure: "continue_without_realtime", forbidGapAsFinalAnswer: true },
    completion: { artifacts: [], requiredTools: [], answerSchema: { requiredSections: [] } },
    checklistPrompt: [],
  } satisfies ScenarioRecipe);
