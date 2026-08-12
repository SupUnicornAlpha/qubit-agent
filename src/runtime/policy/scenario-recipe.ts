import { listLoadedRecipes } from "./load-recipe-json";
import type { ScenarioRecipe } from "./types";

const RECIPES: ScenarioRecipe[] = listLoadedRecipes();

const BY_KEY = new Map<string, ScenarioRecipe>();
for (const recipe of RECIPES) {
  BY_KEY.set(recipe.key, recipe);
  for (const alias of recipe.aliases) {
    BY_KEY.set(alias, recipe);
  }
}

export function resolveScenarioRecipe(
  scenarioKey: string | null | undefined
): ScenarioRecipe | null {
  if (!scenarioKey) return null;
  const key = scenarioKey.trim();
  if (!key) return null;
  return BY_KEY.get(key) ?? BY_KEY.get(key.toLowerCase()) ?? null;
}

export function listScenarioRecipes(): ScenarioRecipe[] {
  return [...RECIPES];
}
