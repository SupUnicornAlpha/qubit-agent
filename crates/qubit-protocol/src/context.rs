//! Context Protocol envelope and finance-structured memory (01 §15).

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::ExecutionKind;
use crate::ids::{AgentSpecId, SessionId, TurnId};

pub const CONTEXT_PROTOCOL_VERSION: &str = "1";

/// Experience / LTM finance subKinds used for recall routing (implementation OUT).
pub const FINANCE_SUB_KINDS: &[&str] = &[
    "factor_archive",
    "strategy_eval",
    "regime",
    "market_snapshot",
    "research_conclusion",
    "pnl_episode",
    "strategy_recipe",
    "playbook",
    "postmortem",
    "execution_profile",
];

pub const FINANCE_RECALL_PREFER_SUB_KINDS: &[&str] = &[
    "research_conclusion",
    "factor_archive",
    "strategy_recipe",
    "regime",
    "strategy_eval",
    "playbook",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ContextSlotId {
    Identity,
    Goal,
    Slot,
    Working,
    Session,
    RecallFinance,
    RecallSkill,
    RecallGeneral,
    Tools,
    Control,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CompressMode {
    Truncate,
    Stub,
    Summarize,
    Omit,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextSlotBudget {
    pub max_chars: u32,
    pub compress: CompressMode,
    pub priority: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextSlotContent {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct RenderedPrompt {
    pub system: String,
    pub user: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextEnvelope {
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
    pub agent_spec_id: AgentSpecId,
    pub execution_kind: ExecutionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_cutoff: Option<String>,
    #[serde(default)]
    pub axioms_applied: Vec<String>,
    #[serde(default)]
    pub slots: BTreeMap<String, ContextSlotContent>,
    #[serde(default)]
    pub budget: BTreeMap<String, ContextSlotBudget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rendered: Option<RenderedPrompt>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStance {
    Bull,
    Bear,
    Neutral,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Open,
    Supported,
    Refuted,
    Stale,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkingClaim {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stance: Option<ClaimStance>,
    #[serde(default)]
    pub symbols: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    pub status: ClaimStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkingDebate {
    #[serde(default)]
    pub bull_points: Vec<String>,
    #[serde(default)]
    pub bear_points: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize, JsonSchema)]
pub struct WorkingMemoryFinanceRefs {
    #[serde(default)]
    pub factor_ids: Vec<String>,
    #[serde(default)]
    pub composition_ids: Vec<String>,
    #[serde(default)]
    pub evaluation_ids: Vec<String>,
    #[serde(default)]
    pub symbols: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct TrailStub {
    pub step: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    pub ok: bool,
    pub one_liner: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct WorkingMemory {
    pub version: u32,
    #[serde(default)]
    pub hypotheses: Vec<WorkingClaim>,
    #[serde(default)]
    pub open_questions: Vec<String>,
    #[serde(default)]
    pub decisions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debate: Option<WorkingDebate>,
    #[serde(default)]
    pub finance_refs: WorkingMemoryFinanceRefs,
    #[serde(default)]
    pub trail_stub: Vec<TrailStub>,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DecisionDomain {
    Research,
    Factor,
    Strategy,
    Trade,
    Regime,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Stance {
    Bull,
    Bear,
    Neutral,
    Hold,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct QuantAnchor {
    #[serde(default)]
    pub factor_ids: Vec<String>,
    #[serde(default)]
    pub composition_ids: Vec<String>,
    #[serde(default)]
    pub evaluation_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum OutcomeLabel {
    Success,
    Fail,
    Partial,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DecisionOutcome {
    pub label: OutcomeLabel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realized_return: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excess_return: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brier_contribution: Option<f64>,
    pub scored_at: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct DecisionRecord {
    pub id: String,
    pub domain: DecisionDomain,
    #[serde(default)]
    pub symbols: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stance: Option<Stance>,
    pub confidence: f64,
    pub asof: String,
    pub thesis: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub horizon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quant_anchor: Option<QuantAnchor>,
    pub source_run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<DecisionOutcome>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HandoffEvidenceKind {
    MarketData,
    News,
    Analysis,
    Factor,
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct HandoffEvidence {
    pub kind: HandoffEvidenceKind,
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

/// Structured handoff returned by subagent / reactor / invoked primary.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextHandoffV1 {
    pub version: u32,
    pub goal: String,
    #[serde(default)]
    pub symbols: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asof: Option<String>,
    #[serde(default)]
    pub claims: Vec<WorkingClaim>,
    #[serde(default)]
    pub finance_refs: WorkingMemoryFinanceRefs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<HandoffEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub debate: Option<WorkingDebate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrative: Option<String>,
}

/// Default slot budgets aligned with existing TS Context Protocol (axioms.ts).
pub fn default_slot_budgets() -> BTreeMap<String, ContextSlotBudget> {
    let mut m = BTreeMap::new();
    let entries = [
        ("identity", 8_000, CompressMode::Truncate, 100u32),
        ("tools", 6_000, CompressMode::Truncate, 95),
        ("goal", 2_000, CompressMode::Truncate, 90),
        ("slot", 6_000, CompressMode::Truncate, 85),
        ("recall_finance", 4_000, CompressMode::Truncate, 80),
        ("recall_skill", 3_500, CompressMode::Truncate, 75),
        ("working", 5_000, CompressMode::Stub, 70),
        ("session", 4_000, CompressMode::Truncate, 60),
        ("recall_general", 2_500, CompressMode::Truncate, 50),
        ("control", 1_500, CompressMode::Truncate, 40),
    ];
    for (id, max_chars, compress, priority) in entries {
        m.insert(
            id.to_string(),
            ContextSlotBudget {
                max_chars,
                compress,
                priority,
            },
        );
    }
    m
}

pub fn system_slot_order() -> &'static [&'static str] {
    &["identity", "tools", "control"]
}

pub fn user_slot_order() -> &'static [&'static str] {
    &[
        "goal",
        "slot",
        "recall_finance",
        "recall_skill",
        "recall_general",
        "session",
        "working",
        // `control` stays system-only (see system_slot_order) — do not duplicate into user.
    ]
}
