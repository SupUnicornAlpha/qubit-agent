import type { ScenarioRecipe } from "./types";
import { stockPickRecipe } from "./recipes/stock-pick";
import { factorRecipe } from "./recipes/factor";
import { strategyRecipe } from "./recipes/strategy";
import { liveTradingRecipe } from "./recipes/live-trading";
import { researchRecipe } from "./recipes/research";

const RECIPES: ScenarioRecipe[] = [
  stockPickRecipe,
  factorRecipe,
  strategyRecipe,
  liveTradingRecipe,
  researchRecipe,
];

const BY_KEY = new Map<string, ScenarioRecipe>();
for (const recipe of RECIPES) {
  BY_KEY.set(recipe.key, recipe);
  for (const alias of recipe.aliases) {
    BY_KEY.set(alias, recipe);
  }
}

export function resolveScenarioRecipe(scenarioKey: string | null | undefined): ScenarioRecipe | null {
  if (!scenarioKey) return null;
  const key = scenarioKey.trim();
  if (!key) return null;
  return BY_KEY.get(key) ?? BY_KEY.get(key.toLowerCase()) ?? null;
}

export function listScenarioRecipes(): ScenarioRecipe[] {
  return [...RECIPES];
}
