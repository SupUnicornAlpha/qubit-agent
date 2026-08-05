//! Slot-budget prompt assembly aligned with existing TS Context Protocol.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use qubit_protocol::{
    default_slot_budgets, system_slot_order, user_slot_order, AgentSpec, CompressMode,
    ContextEnvelope, ContextSlotBudget, ContextSlotContent, InteractionMode, RenderedPrompt,
    SessionView, WorkingMemory, CONTEXT_PROTOCOL_VERSION,
};

use crate::error::RuntimeError;

use super::ports::{
    IdentityPromptLoader, RecallPort, WorkspaceContextPort, WorkspaceFocus,
};

#[derive(Clone, Debug)]
pub struct SlotAssembleInput {
    pub session: SessionView,
    pub spec: AgentSpec,
    pub goal_text: String,
    pub tool_names: Vec<String>,
    pub working: Option<WorkingMemory>,
    pub decision_cutoff: Option<String>,
    pub focus: WorkspaceFocus,
}

#[async_trait]
pub trait ContextAssembler: Send + Sync {
    async fn build(&self, input: SlotAssembleInput) -> Result<ContextEnvelope, RuntimeError>;
}

pub struct DefaultContextAssembler {
    recall: Arc<dyn RecallPort>,
    workspace: Arc<dyn WorkspaceContextPort>,
    identity: Arc<dyn IdentityPromptLoader>,
}

impl DefaultContextAssembler {
    pub fn new(
        recall: Arc<dyn RecallPort>,
        workspace: Arc<dyn WorkspaceContextPort>,
        identity: Arc<dyn IdentityPromptLoader>,
    ) -> Self {
        Self {
            recall,
            workspace,
            identity,
        }
    }

    pub fn with_empty_ports(identity: Arc<dyn IdentityPromptLoader>) -> Self {
        use super::ports::{EmptyRecallPort, EmptyWorkspacePort};
        Self::new(
            Arc::new(EmptyRecallPort),
            Arc::new(EmptyWorkspacePort),
            identity,
        )
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
}

fn apply_budget(text: String, budget: &ContextSlotBudget) -> Option<ContextSlotContent> {
    if budget.compress == CompressMode::Omit {
        return None;
    }
    let t = truncate(&text, budget.max_chars as usize);
    if t.trim().is_empty() {
        return None;
    }
    Some(ContextSlotContent { text: t, meta: None })
}

fn render_hits(hits: &[super::ports::RecallHit]) -> String {
    if hits.is_empty() {
        return String::new();
    }
    hits.iter()
        .map(|h| {
            format!(
                "- [{}] {} ({})",
                h.sub_kind.as_deref().unwrap_or("note"),
                h.title,
                h.summary
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_working(wm: &WorkingMemory) -> String {
    let mut parts = Vec::new();
    if !wm.hypotheses.is_empty() {
        parts.push(format!(
            "hypotheses: {}",
            wm.hypotheses
                .iter()
                .map(|h| h.text.as_str())
                .collect::<Vec<_>>()
                .join("; ")
        ));
    }
    if !wm.open_questions.is_empty() {
        parts.push(format!("open: {}", wm.open_questions.join("; ")));
    }
    if !wm.decisions.is_empty() {
        parts.push(format!("decisions: {}", wm.decisions.join("; ")));
    }
    if !wm.finance_refs.symbols.is_empty() {
        parts.push(format!("symbols: {}", wm.finance_refs.symbols.join(",")));
    }
    parts.join("\n")
}

fn mode_control_text(mode: InteractionMode) -> String {
    match mode {
        InteractionMode::Plan => {
            "MODE=plan: only call update_plan; do not execute side-effect tools.".into()
        }
        InteractionMode::Goal => {
            "MODE=goal: maintain goal+steps via update_plan; verify completion before finishing."
                .into()
        }
        InteractionMode::Ask => {
            "MODE=ask: answer with analysis; prefer read-only tools.".into()
        }
        InteractionMode::Diagnose => {
            "MODE=diagnose: focus on root-cause, ledger, and failure attribution.".into()
        }
        InteractionMode::Agent => "MODE=agent: full tool surface within policy.".into(),
    }
}

#[async_trait]
impl ContextAssembler for DefaultContextAssembler {
    async fn build(&self, input: SlotAssembleInput) -> Result<ContextEnvelope, RuntimeError> {
        let budgets = default_slot_budgets();
        let identity = if let Some(ref prompt) = input.spec.system_prompt {
            if prompt.trim().is_empty() {
                self.identity.load(&input.spec.identity_prompt_ref).await?
            } else {
                prompt.clone()
            }
        } else {
            self.identity.load(&input.spec.identity_prompt_ref).await?
        };
        let slot = self
            .workspace
            .snapshot(input.session.workspace_id.as_str(), &input.focus)
            .await?;
        let finance = self.recall.recall_finance(&input.goal_text).await?;
        let skill = self.recall.recall_skill(&input.goal_text).await?;
        let general = self.recall.recall_general(&input.goal_text).await?;

        let mut raw: BTreeMap<String, String> = BTreeMap::new();
        raw.insert("identity".into(), identity);
        raw.insert(
            "tools".into(),
            if input.tool_names.is_empty() {
                "(no tools)".into()
            } else {
                format!("tools: {}", input.tool_names.join(", "))
            },
        );
        raw.insert(
            "control".into(),
            mode_control_text(input.session.interaction_mode),
        );
        raw.insert("goal".into(), input.goal_text.clone());
        raw.insert("slot".into(), slot.text);
        raw.insert("recall_finance".into(), render_hits(&finance));
        raw.insert("recall_skill".into(), render_hits(&skill));
        raw.insert("recall_general".into(), render_hits(&general));
        raw.insert(
            "session".into(),
            format!(
                "session={} kind={:?} mode={}",
                input.session.session_id,
                input.session.execution_kind,
                input.session.interaction_mode.as_str()
            ),
        );
        if let Some(ref wm) = input.working {
            raw.insert("working".into(), render_working(wm));
        }

        let mut slots: BTreeMap<String, ContextSlotContent> = BTreeMap::new();
        for (id, text) in raw {
            let budget = budgets.get(&id).cloned().unwrap_or(ContextSlotBudget {
                max_chars: 2_000,
                compress: CompressMode::Truncate,
                priority: 50,
            });
            if let Some(c) = apply_budget(text, &budget) {
                slots.insert(id, c);
            }
        }

        let mut system_parts = Vec::new();
        for id in system_slot_order() {
            if let Some(s) = slots.get(*id) {
                system_parts.push(s.text.clone());
            }
        }
        let mut user_parts = Vec::new();
        for id in user_slot_order() {
            if let Some(s) = slots.get(*id) {
                user_parts.push(s.text.clone());
            }
        }

        Ok(ContextEnvelope {
            version: CONTEXT_PROTOCOL_VERSION.into(),
            session_id: Some(input.session.session_id.clone()),
            turn_id: None,
            agent_spec_id: input.spec.id.clone(),
            execution_kind: input.spec.execution_kind,
            decision_cutoff: input.decision_cutoff,
            axioms_applied: vec![
                "A1".into(),
                "A2".into(),
                "A3".into(),
                "A4".into(),
                "A5".into(),
                "A6".into(),
            ],
            slots,
            budget: budgets,
            rendered: Some(RenderedPrompt {
                system: system_parts.join("\n\n"),
                user: user_parts.join("\n\n"),
            }),
        })
    }
}
