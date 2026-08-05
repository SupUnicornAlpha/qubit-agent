use std::collections::HashMap;
use std::sync::Arc;

use crate::recipe::ScenarioRecipe;
use crate::PolicyError;

/// In-memory recipe index (key + aliases).
#[derive(Clone, Default)]
pub struct RecipeCatalog {
    by_key: Arc<HashMap<String, ScenarioRecipe>>,
}

impl RecipeCatalog {
    pub fn from_recipes(recipes: Vec<ScenarioRecipe>) -> Self {
        let mut map = HashMap::new();
        for recipe in recipes {
            map.insert(recipe.key.clone(), recipe.clone());
            for alias in &recipe.aliases {
                map.insert(alias.clone(), recipe.clone());
            }
        }
        Self {
            by_key: Arc::new(map),
        }
    }

    pub fn resolve(&self, key: &str) -> Option<&ScenarioRecipe> {
        self.by_key
            .get(key)
            .or_else(|| self.by_key.get(&key.to_lowercase()))
    }

    pub fn list(&self) -> Vec<ScenarioRecipe> {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for recipe in self.by_key.values() {
            if seen.insert(recipe.key.clone()) {
                out.push(recipe.clone());
            }
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }

    pub fn insert_json(&mut self, json: &str) -> Result<(), PolicyError> {
        let recipe: ScenarioRecipe = serde_json::from_str(json)?;
        let mut map = (*self.by_key).clone();
        map.insert(recipe.key.clone(), recipe.clone());
        for alias in &recipe.aliases {
            map.insert(alias.clone(), recipe.clone());
        }
        self.by_key = Arc::new(map);
        Ok(())
    }
}

/// Built-in recipes shipped with the crate (M5 grayscale).
pub fn builtin_catalog() -> RecipeCatalog {
    let recipes = vec![
        serde_json::from_str(include_str!("../recipes/open.json")).expect("open.json"),
        serde_json::from_str(include_str!("../recipes/stock_pick.json")).expect("stock_pick.json"),
        serde_json::from_str(include_str!("../recipes/factor.json")).expect("factor.json"),
        serde_json::from_str(include_str!("../recipes/strategy.json")).expect("strategy.json"),
        serde_json::from_str(include_str!("../recipes/research.json")).expect("research.json"),
        serde_json::from_str(include_str!("../recipes/live_trading.json"))
            .expect("live_trading.json"),
    ];
    RecipeCatalog::from_recipes(recipes)
}
