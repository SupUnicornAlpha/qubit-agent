//! Invocation and trigger events (01 §6.7).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::TriggerSpec;
use crate::context::ContextHandoffV1;
use crate::delivery::DeliveryVerdict;
use crate::ids::{
    AgentInstanceId, AgentSpecId, InvocationId, SessionId, TriggerEventId, TurnId, WorkspaceId,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InvocationBudget {
    pub max_iterations: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_surface_override: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InvocationRequest {
    pub invocation_id: InvocationId,
    pub parent_session_id: SessionId,
    pub parent_turn_id: TurnId,
    pub caller_instance_id: AgentInstanceId,
    pub callee_spec_id: AgentSpecId,
    pub goal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_in: Option<ContextHandoffV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<i64>,
    pub budget: InvocationBudget,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InvocationState {
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

impl InvocationState {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct InvocationRecord {
    pub request: InvocationRequest,
    pub child_session_id: SessionId,
    pub child_turn_id: TurnId,
    pub state: InvocationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_out: Option<ContextHandoffV1>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<DeliveryVerdict>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TriggerEvent {
    pub event_id: TriggerEventId,
    pub source: TriggerSpec,
    pub payload: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_spec_id: Option<AgentSpecId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}
