/** @deprecated Prefer resolveScenarioRecipe / listLoadedRecipes — JSON is the source of truth. */
import { resolveScenarioRecipe } from "../scenario-recipe";
import type { ScenarioRecipe } from "../types";

export const stockPickRecipe: ScenarioRecipe =
  resolveScenarioRecipe("stock_pick") ??
  ({
    key: "stock_pick",
    aliases: [],
    version: "missing",
    stallBudget: { tools: [], key: "tool_fingerprint", maxSuccess: 1, onExceed: "strip_from_surface" },
    recovery: { afterProbeFailure: "continue_without_realtime", forbidGapAsFinalAnswer: true },
    completion: { artifacts: [], requiredTools: [], answerSchema: { requiredSections: [] } },
    checklistPrompt: [],
  } satisfies ScenarioRecipe);
