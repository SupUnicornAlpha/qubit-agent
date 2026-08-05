//! Session / workspace views (01 §6).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::ExecutionKind;
use crate::ids::{AgentInstanceId, AgentSpecId, SessionId, WorkspaceId};
use crate::mode::InteractionMode;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkspaceRef {
    pub id: WorkspaceId,
    pub root_path: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Archived,
    Degraded,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionView {
    pub session_id: SessionId,
    pub workspace_id: WorkspaceId,
    pub agent_instance_id: AgentInstanceId,
    pub agent_spec_id: AgentSpecId,
    pub execution_kind: ExecutionKind,
    /// Control / interaction mode for this session (agent|plan|goal|ask|diagnose).
    #[serde(default)]
    pub interaction_mode: InteractionMode,
    pub status: SessionStatus,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    /// Monotonic event seq for `events.subscribe(from_seq)`.
    pub event_seq: u64,
}
