//! Policy snapshot wire types (01 §10). Recipe DATA lives in `qubit-policy`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::delivery::{EffectKind, EffectRecord};

/// Thin snapshot Core reads once per iteration / finalize.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct PolicySnapshot {
    pub recipe_key: Option<String>,
    pub recipe_version: Option<String>,
    /// Content hash for checkpoint pinning.
    pub snapshot_hash: String,
    #[serde(default)]
    pub tool_allowlist: Vec<String>,
    pub completion: CompletionPredicate,
    #[serde(default)]
    pub checklist_prompt: Vec<String>,
    /// Stall / tool-loop budget (from recipe.stall_budget).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall: Option<StallPolicy>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct StallPolicy {
    /// Empty → apply to all tools.
    #[serde(default)]
    pub tools: Vec<String>,
    /// `tool` | `tool_fingerprint` | `tool_market`
    pub key: String,
    pub max_success: u32,
    pub on_exceed: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct CompletionPredicate {
    #[serde(default)]
    pub artifacts: Vec<ArtifactPredicate>,
    #[serde(default)]
    pub required_tools: Vec<RequiredToolPredicate>,
    #[serde(default)]
    pub answer_schema: AnswerSchemaPredicate,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ArtifactPredicate {
    /// Matches `EffectRecord.key` (or legacy table name).
    pub key: String,
    pub min_count: u32,
    /// Research / lifecycle floor. Default 1. 0 = optional for researchOk.
    #[serde(default = "default_research_min")]
    pub research_min_count: u32,
}

fn default_research_min() -> u32 {
    1
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RequiredToolPredicate {
    /// Capability or exact tool name (prefix / equality match in evaluator).
    pub capability: String,
    pub min_success: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AnswerSchemaPredicate {
    #[serde(default)]
    pub required_sections: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_chars: Option<u32>,
}

/// Append-only effect + successful tool names collected during a turn.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EffectLedger {
    #[serde(default)]
    pub effects: Vec<EffectRecord>,
    #[serde(default)]
    pub successful_tools: Vec<String>,
    #[serde(default)]
    pub attempted_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_text: Option<String>,
}

impl EffectLedger {
    pub fn record_tool_results(
        &mut self,
        tool_name: &str,
        ok: bool,
        effects: impl IntoIterator<Item = EffectRecord>,
    ) {
        self.attempted_tools.push(tool_name.to_string());
        if ok {
            if !self.successful_tools.iter().any(|t| t == tool_name) {
                self.successful_tools.push(tool_name.to_string());
            }
            self.effects.extend(effects);
        }
    }

    pub fn count_artifact(&self, key: &str) -> u32 {
        self.effects
            .iter()
            .filter(|e| {
                matches!(
                    e.kind,
                    EffectKind::Artifact | EffectKind::Other | EffectKind::RowUpsert
                ) && e.key == key
            })
            .count() as u32
    }
}
