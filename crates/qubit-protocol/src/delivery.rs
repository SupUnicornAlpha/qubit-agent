//! Delivery verdict and effect ledger shapes (01 §10).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ids::ToolCallId;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Delivered,
    DeliveredWithGaps,
    Partial,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DeliveryVerdict {
    pub status: DeliveryStatus,
    #[serde(default)]
    pub reasons: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EffectKind {
    RowUpsert,
    FileWrite,
    Artifact,
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EffectRecord {
    pub kind: EffectKind,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ToolResult {
    pub call_id: ToolCallId,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<serde_json::Value>,
    #[serde(default)]
    pub effects: Vec<EffectRecord>,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}
