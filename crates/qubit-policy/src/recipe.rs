//! Scenario recipe shapes aligned with `src/runtime/policy/types.ts` (subset).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StallBudgetKey {
    Tool,
    ToolMarket,
    ToolFingerprint,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StallBudget {
    pub tools: Vec<String>,
    pub key: StallBudgetKey,
    pub max_success: u32,
    pub on_exceed: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ArtifactSpec {
    pub table: String,
    pub min_rows: u32,
    #[serde(default)]
    pub research_min_rows: Option<u32>,
    #[serde(default)]
    pub required_fields: Vec<String>,
    #[serde(default = "default_scope")]
    pub scope: String,
}

fn default_scope() -> String {
    "workflow".into()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RequiredToolSpec {
    pub capability: String,
    pub min_success: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AnswerSchemaSpec {
    #[serde(default)]
    pub required_sections: Vec<String>,
    #[serde(default)]
    pub min_chars: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CompletionSpec {
    #[serde(default)]
    pub artifacts: Vec<ArtifactSpec>,
    #[serde(default)]
    pub required_tools: Vec<RequiredToolSpec>,
    #[serde(default)]
    pub answer_schema: AnswerSchemaSpec,
}

impl Default for AnswerSchemaSpec {
    fn default() -> Self {
        Self {
            required_sections: vec![],
            min_chars: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RecoverySpec {
    pub after_probe_failure: String,
    pub forbid_gap_as_final_answer: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ScenarioRecipe {
    pub key: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub version: String,
    #[serde(default)]
    pub capability_owners: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub role_tool_allowlist: Option<BTreeMap<String, Vec<String>>>,
    pub stall_budget: StallBudget,
    pub recovery: RecoverySpec,
    pub completion: CompletionSpec,
    #[serde(default)]
    pub checklist_prompt: Vec<String>,
}
