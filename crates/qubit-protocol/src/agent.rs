//! Agent execution kinds and configuration (01 §6.6).
//!
//! Core never branches on business roles (researcher, …) — only on [`ExecutionKind`].

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::ids::{AgentInstanceId, AgentSpecId, WorkspaceId};

/// Who may own user turns, who is invoke-only, who is event-driven.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionKind {
    /// User-facing hub; may also be invoked by other agents.
    Primary,
    /// Expert; invoke-only; isolated context window.
    Subagent,
    /// External trigger (MQ / A2A / webhook / domain event).
    Reactor,
}

/// Who is allowed to `agent.invoke` this spec.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CallerSelector {
    SpecId {
        id: String,
    },
    Label {
        label: String,
    },
    /// Field renamed from `kind` to avoid serde internal-tag clash with `tag = "kind"`.
    ExecutionKind {
        execution_kind: ExecutionKind,
    },
}

/// External wake-up sources for [`ExecutionKind::Reactor`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TriggerSpec {
    Queue {
        topic: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filter: Option<serde_json::Value>,
    },
    A2a {
        capability: String,
    },
    Webhook {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        secret_ref: Option<String>,
    },
    DomainEvent {
        event_name: String,
    },
    Schedule {
        cron: String,
    },
}

/// Versioned agent configuration. Business meaning lives in labels / prompt refs.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentSpec {
    pub id: AgentSpecId,
    pub version: String,
    pub display_name: String,
    pub execution_kind: ExecutionKind,
    /// Free-form labels (orchestrator / research / …). Core must not match on these.
    #[serde(default)]
    pub labels: Vec<String>,
    pub identity_prompt_ref: String,
    /// Full system prompt body (synced from Bun agent_definition). Preferred over stub identity loader.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_recipe_id: Option<String>,
    pub tool_surface_ref: String,
    /// Exact per-agent tool surface. Core advertises only this configured
    /// subset (plus L0 control tools), so schemas are loaded on demand rather
    /// than for every bridge capability.
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_ref: Option<String>,
    pub max_iterations: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hitl_profile_ref: Option<String>,
    /// Empty → kind defaults (subagent: primary only; primary: configured callers).
    #[serde(default)]
    pub allowed_callers: Vec<CallerSelector>,
    #[serde(default)]
    pub triggers: Vec<TriggerSpec>,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentInstanceStatus {
    Ready,
    Busy,
    Disabled,
    Degraded,
}

/// Runtime binding of a spec to a workspace.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentInstance {
    pub instance_id: AgentInstanceId,
    pub spec_id: AgentSpecId,
    pub workspace_id: WorkspaceId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_instance_id: Option<AgentInstanceId>,
    pub status: AgentInstanceStatus,
}
