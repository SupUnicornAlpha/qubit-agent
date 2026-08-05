//! HITL prompts and approval inbox (01 §6.4 / §6.8).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::ExecutionKind;
use crate::ids::{
    AgentInstanceId, HitlInboxId, HitlPromptId, SessionId, TurnId, WorkspaceId,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HitlInputKind {
    ApproveOnly,
    SingleChoice,
    MultiChoice,
    FreeForm,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HitlOption {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HitlPrompt {
    pub id: HitlPromptId,
    pub turn_id: TurnId,
    pub input_kind: HitlInputKind,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub options: Vec<HitlOption>,
    #[serde(default)]
    pub hard_rule: bool,
    pub created_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HitlSource {
    UserTurn,
    Invocation,
    ReactorTrigger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HitlInboxStatus {
    Pending,
    Approved,
    Rejected,
    Expired,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HitlChannelHint {
    IdePanel,
    ImWebhook { target_ref: String },
    Notification,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HitlInboxItem {
    pub inbox_id: HitlInboxId,
    pub prompt: HitlPrompt,
    pub workspace_id: WorkspaceId,
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub agent_instance_id: AgentInstanceId,
    pub execution_kind: ExecutionKind,
    pub source: HitlSource,
    pub status: HitlInboxStatus,
    pub created_at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at_ms: Option<i64>,
    #[serde(default)]
    pub channel_hints: Vec<HitlChannelHint>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HitlResponse {
    pub inbox_id: HitlInboxId,
    pub approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_option_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub free_form: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_meta: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HitlInboxFilter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default)]
    pub pending_only: bool,
}
