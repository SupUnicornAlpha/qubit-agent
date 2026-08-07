//! Slot-budget prompt assembly aligned with existing TS Context Protocol.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use qubit_protocol::{
    default_slot_budgets, system_slot_order, user_slot_order, AgentSpec, CompressMode,
    ContextEnvelope, ContextSlotBudget, ContextSlotContent, InteractionMode, RenderedPrompt,
    SessionView, TurnContextOpts, WorkingMemory, CONTEXT_PROTOCOL_VERSION,
};

use crate::error::RuntimeError;

use super::ports::{
    IdentityPromptLoader, RecallBundle, RecallHit, RecallPort, WorkspaceContextPort, WorkspaceFocus,
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
    pub context: TurnContextOpts,
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

fn render_hits(hits: &[RecallHit]) -> String {
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

fn maybe_wrap_background(enabled: bool, label: &str, body: String) -> String {
    if body.trim().is_empty() {
        return String::new();
    }
    if !enabled {
        return body;
    }
    format!("OPTIONAL_BACKGROUND ({label}) — do NOT override CURRENT_USER_TASK:\n{body}")
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
        InteractionMode::Plan => concat!(
            "MODE=plan: only call update_plan; do not execute side-effect tools.\n",
            "Write 3-7 pending steps, then answer with tool=none. Do not mark steps done in Plan mode."
        )
        .into(),
        InteractionMode::Goal => concat!(
            "MODE=goal: you MUST keep the plan current via update_plan while executing.\n",
            "Rules:\n",
            "1) Before/while working: keep exactly one step status=in_progress.\n",
            "2) After finishing a step: set it to done (or skipped with a reason) before the next tool batch.\n",
            "3) Do not finish (tool=none) while any step is still pending or in_progress.\n",
            "4) Never leave the plan stuck at all-pending after you have already used tools."
        )
        .into(),
        InteractionMode::Ask => {
            "MODE=ask: answer with analysis; prefer read-only tools.".into()
        }
        InteractionMode::Diagnose => {
            "MODE=diagnose: focus on root-cause, ledger, and failure attribution.".into()
        }
        InteractionMode::Agent => concat!(
            "MODE=agent: full tool surface within policy.\n",
            "For multi-step research: call update_plan early, keep one in_progress step, and mark done/skipped as you go so the UI plan progress stays truthful."
        )
        .into(),
    }
}

fn take_top(hits: Vec<RecallHit>, n: usize) -> Vec<RecallHit> {
    hits.into_iter().take(n).collect()
}

fn apply_recall_opts(bundle: RecallBundle, opts: &TurnContextOpts) -> RecallBundle {
    let k = opts.recall_top_k_or(usize::MAX);
    RecallBundle {
        finance: if opts.include_finance_recall() {
            take_top(bundle.finance, k)
        } else {
            Vec::new()
        },
        skill: if opts.include_skill_recall() {
            take_top(bundle.skill, k)
        } else {
            Vec::new()
        },
        general: if opts.include_general_recall() {
            take_top(bundle.general, k)
        } else {
            Vec::new()
        },
    }
}

#[async_trait]
impl ContextAssembler for DefaultContextAssembler {
    async fn build(&self, input: SlotAssembleInput) -> Result<ContextEnvelope, RuntimeError> {
        let budgets = default_slot_budgets();
        let opts = &input.context;
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

        let bundle = if opts.auto_recall_enabled() {
            apply_recall_opts(
                self.recall.recall_bundle(&input.goal_text).await?,
                opts,
            )
        } else {
            RecallBundle::default()
        };

        let prioritize = opts.prioritize_current_goal();
        let goal_block = if prioritize {
            format!(
                "## CURRENT_USER_TASK (authoritative — execute THIS, ignore conflicting background)\n{}",
                input.goal_text.trim()
            )
        } else {
            input.goal_text.clone()
        };

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
        raw.insert("goal".into(), goal_block);
        raw.insert(
            "slot".into(),
            maybe_wrap_background(prioritize, "workspace", slot.text),
        );
        raw.insert(
            "recall_finance".into(),
            maybe_wrap_background(prioritize, "recall_finance", render_hits(&bundle.finance)),
        );
        raw.insert(
            "recall_skill".into(),
            maybe_wrap_background(prioritize, "recall_skill", render_hits(&bundle.skill)),
        );
        raw.insert(
            "recall_general".into(),
            maybe_wrap_background(prioritize, "recall_general", render_hits(&bundle.general)),
        );
        raw.insert(
            "session".into(),
            {
                let meta = format!(
                    "session={} kind={:?} mode={}",
                    input.session.session_id,
                    input.session.execution_kind,
                    input.session.interaction_mode.as_str()
                );
                match opts.session_chronicle() {
                    Some(chronicle) => {
                        let body = format!("{meta}\n\n{chronicle}");
                        maybe_wrap_background(prioritize, "session_chronicle", body)
                    }
                    None => meta,
                }
            },
        );
        if let Some(ref wm) = input.working {
            raw.insert(
                "working".into(),
                maybe_wrap_background(prioritize, "working_memory", render_working(wm)),
            );
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_recall_opts_respects_flags_and_top_k() {
        let bundle = RecallBundle {
            finance: vec![
                RecallHit {
                    title: "a".into(),
                    summary: "1".into(),
                    sub_kind: None,
                    asof: None,
                    score: 1.0,
                },
                RecallHit {
                    title: "b".into(),
                    summary: "2".into(),
                    sub_kind: None,
                    asof: None,
                    score: 0.5,
                },
            ],
            skill: vec![RecallHit {
                title: "s".into(),
                summary: "x".into(),
                sub_kind: None,
                asof: None,
                score: 1.0,
            }],
            general: vec![RecallHit {
                title: "g".into(),
                summary: "y".into(),
                sub_kind: None,
                asof: None,
                score: 1.0,
            }],
        };
        let opts = TurnContextOpts {
            recall_top_k: Some(1),
            include_finance_recall: Some(true),
            include_skill_recall: Some(false),
            include_general_recall: Some(true),
            ..Default::default()
        };
        let out = apply_recall_opts(bundle, &opts);
        assert_eq!(out.finance.len(), 1);
        assert!(out.skill.is_empty());
        assert_eq!(out.general.len(), 1);
    }
}
