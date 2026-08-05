//! Recipe JSON → [`PolicySnapshot`] (01 §10). No Delivery evaluation here.

mod catalog;
mod error;
mod recipe;

pub use catalog::{builtin_catalog, RecipeCatalog};
pub use error::PolicyError;
pub use recipe::{ScenarioRecipe, StallBudget, StallBudgetKey};

use qubit_protocol::{
    AnswerSchemaPredicate, ArtifactPredicate, CompletionPredicate, PolicySnapshot,
    RequiredToolPredicate, StallPolicy,
};
use sha2::{Digest, Sha256};

/// Build a pinned snapshot from a recipe key (aliases resolved via catalog).
pub fn load_policy_snapshot(
    catalog: &RecipeCatalog,
    recipe_key: Option<&str>,
) -> Result<PolicySnapshot, PolicyError> {
    let Some(key) = recipe_key.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(missing_recipe_snapshot());
    };
    let recipe = catalog
        .resolve(key)
        .ok_or_else(|| PolicyError::UnknownRecipe(key.to_string()))?;
    Ok(snapshot_from_recipe(recipe))
}

pub fn snapshot_from_recipe(recipe: &ScenarioRecipe) -> PolicySnapshot {
    let completion = CompletionPredicate {
        artifacts: recipe
            .completion
            .artifacts
            .iter()
            .map(|a| ArtifactPredicate {
                key: a.table.clone(),
                min_count: a.min_rows,
                research_min_count: a.research_min_rows.unwrap_or(1),
            })
            .collect(),
        required_tools: recipe
            .completion
            .required_tools
            .iter()
            .map(|t| RequiredToolPredicate {
                capability: t.capability.clone(),
                min_success: t.min_success,
            })
            .collect(),
        answer_schema: AnswerSchemaPredicate {
            required_sections: recipe.completion.answer_schema.required_sections.clone(),
            min_chars: recipe.completion.answer_schema.min_chars,
        },
    };

    let mut allow = Vec::new();
    // Tool advertising allowlist is ONLY role_tool_allowlist (DATA surface).
    // Never seed from stall_budget.tools — that list is for strip-on-exceed, and
    // using it (e.g. open recipe's ["update_plan"]) incorrectly hides bridge tools.
    if let Some(ref roles) = recipe.role_tool_allowlist {
        for tools in roles.values() {
            for t in tools {
                if !allow.iter().any(|x| x == t) {
                    allow.push(t.clone());
                }
            }
        }
    }

    let stall = StallPolicy {
        tools: recipe.stall_budget.tools.clone(),
        key: match recipe.stall_budget.key {
            StallBudgetKey::Tool => "tool".into(),
            StallBudgetKey::ToolMarket => "tool_market".into(),
            StallBudgetKey::ToolFingerprint => "tool_fingerprint".into(),
        },
        max_success: recipe.stall_budget.max_success.max(1),
        on_exceed: recipe.stall_budget.on_exceed.clone(),
    };

    let mut snap = PolicySnapshot {
        recipe_key: Some(recipe.key.clone()),
        recipe_version: Some(recipe.version.clone()),
        snapshot_hash: String::new(),
        tool_allowlist: allow,
        completion,
        checklist_prompt: recipe.checklist_prompt.clone(),
        stall: Some(stall),
    };
    snap.snapshot_hash = hash_snapshot(&snap);
    snap
}

fn missing_recipe_snapshot() -> PolicySnapshot {
    let mut snap = PolicySnapshot {
        recipe_key: None,
        recipe_version: None,
        snapshot_hash: String::new(),
        tool_allowlist: vec![],
        completion: CompletionPredicate {
            artifacts: vec![],
            required_tools: vec![],
            answer_schema: AnswerSchemaPredicate {
                required_sections: vec![
                    "goal".into(),
                    "evidence".into(),
                    "decision".into(),
                    "risks".into(),
                    "gaps".into(),
                ],
                min_chars: None,
            },
        },
        checklist_prompt: vec![
            "同类工具成功≤3次后必须停手并用已有证据写终答".into(),
            "禁止无目的连打 mathjs / historical_prices / technical_indicator".into(),
            "有足够证据后下一轮只输出最终中文回答，不再发 tool_calls".into(),
        ],
        stall: Some(StallPolicy {
            tools: vec![],
            key: "tool_fingerprint".into(),
            max_success: 3,
            on_exceed: "strip_from_surface".into(),
        }),
    };
    snap.snapshot_hash = hash_snapshot(&snap);
    snap
}

fn hash_snapshot(snap: &PolicySnapshot) -> String {
    let mut hasher = Sha256::new();
    let payload = serde_json::json!({
        "recipe_key": snap.recipe_key,
        "recipe_version": snap.recipe_version,
        "tool_allowlist": snap.tool_allowlist,
        "completion": snap.completion,
        "checklist_prompt": snap.checklist_prompt,
        "stall": snap.stall,
    });
    hasher.update(payload.to_string().as_bytes());
    hex::encode(hasher.finalize())
}
