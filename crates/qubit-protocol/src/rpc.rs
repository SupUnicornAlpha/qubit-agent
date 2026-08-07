//! JSON-RPC request/response shapes for CoreRuntime (01 §6.3 / §11.4).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::AgentSpec;
use crate::hitl::{HitlInboxFilter, HitlInboxItem, HitlResponse};
use crate::ids::{AgentSpecId, SessionId, TurnId, WorkspaceId};
use crate::invocation::InvocationRecord;
use crate::mode::{AgentPlanSnapshot, InteractionMode};
use crate::session::SessionView;
use crate::turn::{TurnView, UserInput};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionCreate {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<WorkspaceId>,
    pub agent_ref: AgentSpecId,
    /// Preferred: typed interaction mode. Legacy string `mode` still accepted via alias.
    #[serde(default)]
    pub interaction_mode: InteractionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionGet {
    pub session_id: SessionId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionSetMode {
    pub session_id: SessionId,
    pub interaction_mode: InteractionMode,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TurnStart {
    pub session_id: SessionId,
    pub input: UserInput,
    pub idempotency_key: String,
    /// Host-owned context / recall policy for this turn (optional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<crate::TurnContextOpts>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TurnStartResult {
    pub turn_id: TurnId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TurnCancel {
    pub session_id: SessionId,
    pub turn_id: TurnId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct EventsSubscribe {
    pub session_id: SessionId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RuntimeHealth {
    pub status: String,
    pub uptime_ms: u64,
    pub active_turns: u32,
    pub hitl_waiting: u32,
    pub core_backend: String,
    #[serde(default)]
    pub degraded_reasons: Vec<String>,
    /// Model id Core was started with (`QUBIT_LLM_MODEL`). Omitted when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_model: Option<String>,
    /// Base URL Core was started with (`QUBIT_LLM_BASE_URL`). Omitted when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_base_url: Option<String>,
    /// True when Core process has a non-empty LLM API key env at boot.
    #[serde(default)]
    pub has_llm_key: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionSnapshot {
    pub session: SessionView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_turn: Option<TurnView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<AgentPlanSnapshot>,
    /// `agent.invoke` ledger for this session (for Bun UI projection while polling).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub invocations: Vec<InvocationRecord>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentListResult {
    pub agents: Vec<AgentSpec>,
}

/// JSON-RPC method names (wire contract).
pub mod methods {
    pub const SESSION_CREATE: &str = "session.create";
    pub const SESSION_GET: &str = "session.get";
    pub const SESSION_SET_MODE: &str = "session.set_mode";
    pub const TURN_START: &str = "turn.start";
    pub const TURN_CANCEL: &str = "turn.cancel";
    pub const TURN_FAIL: &str = "turn.fail";
    pub const HITL_RESPOND: &str = "hitl.respond";
    pub const HITL_INBOX_LIST: &str = "hitl.inbox.list";
    pub const EVENTS_SUBSCRIBE: &str = "events.subscribe";
    pub const EVENTS_UNSUBSCRIBE: &str = "events.unsubscribe";
    pub const AGENT_LIST: &str = "agent.list";
    pub const AGENT_UPSERT: &str = "agent.upsert";
    pub const AGENT_INVOKE: &str = "agent.invoke";
    pub const TRIGGER_INGEST: &str = "trigger.ingest";
    pub const RUNTIME_HEALTH: &str = "runtime.health";
    pub const SESSION_SNAPSHOT: &str = "session.snapshot";
}

impl SessionCreate {
    /// Resolve typed mode, falling back to legacy string `mode` if needed.
    pub fn resolved_interaction_mode(&self) -> crate::mode::InteractionMode {
        if let Some(ref m) = self.mode {
            return crate::mode::InteractionMode::parse(m).unwrap_or(self.interaction_mode);
        }
        self.interaction_mode
    }
}

/// Re-export response aliases used by CoreRuntime.
pub type HitlRespond = HitlResponse;
pub type HitlInboxList = HitlInboxFilter;
pub type HitlInboxListResult = Vec<HitlInboxItem>;
