//! Session interaction / control modes (orthogonal to ExecutionKind).
//!
//! Cursor-like UI modes (Agent / Plan / Ask / …) map here — they change
//! tool gating and delivery criteria, not which agent kind you are.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// How this Session/Turn is allowed to act.
///
/// Orthogonal to [`crate::ExecutionKind`]:
/// - ExecutionKind = who may talk / be invoked / be triggered
/// - InteractionMode = what the loop may do this session
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InteractionMode {
    /// Full tool surface (default). Maps to Cursor "Agent".
    #[default]
    Agent,
    /// Only `update_plan` (+ read-only L0 helpers). No side-effect tools.
    Plan,
    /// Must maintain goal + steps; delivery gated on plan completion.
    Goal,
    /// Q&A / analysis text; tools denied or read-only surface.
    Ask,
    /// Root-cause / failure attribution: diagnostics tools + ledger replay.
    /// (Renamed from Cursor-ish "Debug" — wire name is `diagnose`.)
    Diagnose,
}

impl InteractionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Plan => "plan",
            Self::Goal => "goal",
            Self::Ask => "ask",
            Self::Diagnose => "diagnose",
        }
    }

    /// Parse wire / legacy string. Accepts deprecated alias `debug` → Diagnose.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "agent" | "chat" | "" => Some(Self::Agent),
            "plan" => Some(Self::Plan),
            "goal" => Some(Self::Goal),
            "ask" => Some(Self::Ask),
            "diagnose" | "debug" => Some(Self::Diagnose),
            _ => None,
        }
    }

    /// Whether a tool name is allowed under this mode (harness rule).
    /// Host may further narrow via PolicySnapshot.
    pub fn allows_tool(self, tool_name: &str) -> bool {
        let name = tool_name.strip_prefix("tool/").unwrap_or(tool_name);
        match self {
            Self::Agent | Self::Goal | Self::Diagnose => true,
            Self::Plan => name == "update_plan",
            Self::Ask => {
                matches!(
                    name,
                    "update_plan" | "workspace.read" | "workspace.list" | "session.diagnose"
                )
            }
        }
    }
}

/// Business research stage. This is intentionally separate from agent-step
/// lifecycle (`perceive/reason/act/observe`) because a research plan can
/// revisit a stage or run stages in parallel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResearchPhase {
    Scope,
    Plan,
    Evidence,
    Analysis,
    Validation,
    Delivery,
}

impl ResearchPhase {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "scope" => Some(Self::Scope),
            "plan" => Some(Self::Plan),
            "evidence" => Some(Self::Evidence),
            "analysis" => Some(Self::Analysis),
            "validation" => Some(Self::Validation),
            "delivery" => Some(Self::Delivery),
            _ => None,
        }
    }
}

/// Runtime state of a research phase. This is optional and only applies to
/// research workflows; generic agents can omit the research extension.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ResearchPhaseStatus {
    Pending,
    Active,
    Completed,
    Revisited,
    Blocked,
}

impl ResearchPhaseStatus {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pending" | "queued" => Some(Self::Pending),
            "active" | "in_progress" | "in-progress" | "running" => Some(Self::Active),
            "completed" | "complete" | "done" => Some(Self::Completed),
            "revisited" | "revisit" | "回访" => Some(Self::Revisited),
            "blocked" | "阻塞" => Some(Self::Blocked),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ResearchPhaseState {
    pub phase: ResearchPhase,
    pub status: ResearchPhaseStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Structured plan artifact written by L0 `update_plan` (existing TS shape).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentPlanSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<InteractionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<AgentGoalSnapshot>,
    #[serde(default)]
    pub steps: Vec<AgentPlanStep>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research_phase: Option<ResearchPhase>,
    /// Optional research-only lifecycle state. Generic Agent plans leave this empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub research_phases: Vec<ResearchPhaseState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Done,
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentPlanStep {
    pub id: String,
    pub title: String,
    pub status: PlanStepStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub research_phase: Option<ResearchPhase>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Planning,
    Executing,
    Paused,
    Completed,
    Blocked,
    Cleared,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct AgentGoalSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<GoalStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_steps: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_steps: Option<u32>,
    #[serde(default)]
    pub success_criteria: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
}

/// Multitask is not a separate InteractionMode — it is primary invoking N subagents.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct MultitaskHint {
    pub max_parallel_invocations: u32,
}
