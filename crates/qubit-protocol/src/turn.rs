//! Turn lifecycle and user input (01 §6.2 / §6.4).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::delivery::DeliveryVerdict;
use crate::ids::TurnId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Accepted,
    Preparing,
    Reasoning,
    Acting,
    Observing,
    AwaitingHitl,
    Finalizing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Completed,
    Failed,
    Cancelled,
    AwaitingHitl,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachmentRef {
    File { r#ref: String },
    KlineContext { r#ref: String },
    ArtifactRef { r#ref: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct UserInput {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_meta: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TurnLlmStats {
    #[serde(default)]
    pub sample_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

impl TurnLlmStats {
    pub fn add_sample(
        &mut self,
        prompt_tokens: Option<u32>,
        completion_tokens: Option<u32>,
        total_tokens: Option<u32>,
        latency_ms: Option<u64>,
        model: Option<String>,
        provider: Option<String>,
    ) {
        self.sample_count = self.sample_count.saturating_add(1);
        if let Some(p) = prompt_tokens {
            self.prompt_tokens = Some(self.prompt_tokens.unwrap_or(0).saturating_add(p));
        }
        if let Some(c) = completion_tokens {
            self.completion_tokens = Some(self.completion_tokens.unwrap_or(0).saturating_add(c));
        }
        let total = total_tokens.or_else(|| {
            if prompt_tokens.is_some() || completion_tokens.is_some() {
                Some(prompt_tokens.unwrap_or(0) + completion_tokens.unwrap_or(0))
            } else {
                None
            }
        });
        if let Some(t) = total {
            self.total_tokens = Some(self.total_tokens.unwrap_or(0).saturating_add(t));
        }
        if let Some(ms) = latency_ms {
            self.latency_ms = Some(self.latency_ms.unwrap_or(0).saturating_add(ms));
        }
        if model.is_some() {
            self.model = model;
        }
        if provider.is_some() {
            self.provider = provider;
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TurnView {
    pub turn_id: TurnId,
    pub state: TurnState,
    pub iteration: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<Lifecycle>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<DeliveryVerdict>,
    /// Final assistant text for delivery / Bun graph projection (optional until completed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_text: Option<String>,
    /// Aggregated LLM usage across iterations (for Bun `llm_call_log`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_stats: Option<TurnLlmStats>,
}
