//! agent.invoke — isolated child session for subagent / invoked primary (01 §6.7).

use std::sync::Arc;

use async_trait::async_trait;
use qubit_protocol::{
    ContextHandoffV1, ExecutionKind, InteractionMode, InvocationRecord, InvocationRequest,
    InvocationState, UserInput,
};

use crate::admission::AgentAdmission;
use crate::cancel::CancelToken;
use crate::cancel_registry::TurnCancelRegistry;
use crate::engine::{TurnEngine, TurnOutcome};
use crate::error::RuntimeError;
use crate::store::{new_turn_id, SharedStore};

/// Late-bound port so L0 tools can call invoke without a cycle at construction.
#[async_trait]
pub trait AgentInvoker: Send + Sync {
    async fn invoke_agent(
        &self,
        req: InvocationRequest,
        cancel: CancelToken,
    ) -> Result<InvocationRecord, RuntimeError>;
}

pub struct InvocationService {
    store: SharedStore,
    admission: Arc<dyn AgentAdmission>,
    engine: Arc<TurnEngine>,
}

impl InvocationService {
    pub fn new(
        store: SharedStore,
        admission: Arc<dyn AgentAdmission>,
        engine: Arc<TurnEngine>,
    ) -> Self {
        Self {
            store,
            admission,
            engine,
        }
    }

    pub async fn invoke(
        &self,
        req: InvocationRequest,
        cancel: CancelToken,
    ) -> Result<InvocationRecord, RuntimeError> {
        self.invoke_registered(req, cancel, None).await
    }

    pub async fn invoke_registered(
        &self,
        req: InvocationRequest,
        cancel: CancelToken,
        cancels: Option<&TurnCancelRegistry>,
    ) -> Result<InvocationRecord, RuntimeError> {
        let parent = self.store.get_session(&req.parent_session_id).await?;
        let caller_spec = self
            .store
            .get_spec(&parent.view.agent_spec_id)
            .await?;
        let callee_spec = self.store.get_spec(&req.callee_spec_id).await?;
        self.admission
            .admit_invocation(&caller_spec, &callee_spec)?;

        // Isolated window: new session, no parent transcript (subagent or invoked primary).
        let workspace_id = parent.view.workspace_id.clone();
        let instance = self
            .store
            .ensure_instance(&callee_spec, workspace_id.clone())
            .await?;
        let child_session = self
            .store
            .create_session(
                workspace_id,
                &instance,
                &callee_spec,
                InteractionMode::Agent,
            )
            .await;

        if callee_spec.execution_kind == ExecutionKind::Subagent
            && child_session.execution_kind != ExecutionKind::Subagent
        {
            return Err(RuntimeError::Internal(
                "subagent session kind mismatch".into(),
            ));
        }

        let child_turn_id = new_turn_id();
        if let Some(reg) = cancels {
            reg.insert(&child_turn_id, cancel.clone()).await;
        }

        // Publish Running so Bun pollers can show tool_call_start mid-turn.
        let running = InvocationRecord {
            request: req.clone(),
            child_session_id: child_session.session_id.clone(),
            child_turn_id: child_turn_id.clone(),
            state: InvocationState::Running,
            handoff_out: None,
            delivery: None,
        };
        let _ = self
            .store
            .upsert_invocation(&req.parent_session_id, running)
            .await;

        let goal_text = build_isolated_goal(&req);
        let max_iters = req
            .budget
            .max_iterations
            .min(callee_spec.max_iterations)
            .max(1);
        let recipe_key = callee_spec
            .default_recipe_id
            .clone()
            .or_else(|| Some("open".into()));

        let run_result = self
            .engine
            .run_turn_preallocated(
                &child_session.session_id,
                child_turn_id.clone(),
                UserInput {
                    text: goal_text.clone(),
                    attachments: vec![],
                    client_meta: None,
                },
                cancel,
                crate::engine::RunTurnOpts {
                    max_iterations: Some(max_iters),
                    recipe_key,
                },
            )
            .await;

        if let Some(reg) = cancels {
            reg.remove(&child_turn_id).await;
        }

        let (child_turn_id, outcome) = match run_result {
            Ok(v) => v,
            Err(e) => {
                if let Err(fail_err) = self
                    .engine
                    .fail_turn(&child_session.session_id, &child_turn_id, &e)
                    .await
                {
                    tracing::error!(
                        turn_id = %child_turn_id,
                        error = %fail_err,
                        "failed to mark child turn as failed after invoke error"
                    );
                }
                let failed = InvocationRecord {
                    request: req.clone(),
                    child_session_id: child_session.session_id,
                    child_turn_id,
                    state: InvocationState::Failed,
                    handoff_out: None,
                    delivery: Some(qubit_protocol::DeliveryVerdict {
                        status: qubit_protocol::DeliveryStatus::Failed,
                        reasons: vec![format!("invoke_error:{e}")],
                    }),
                };
                let _ = self
                    .store
                    .upsert_invocation(&req.parent_session_id, failed.clone())
                    .await;
                return Err(e);
            }
        };

        let (state, delivery) = match outcome {
            TurnOutcome::Finished { delivery } => (InvocationState::Completed, Some(delivery)),
            TurnOutcome::Cancelled => (InvocationState::Cancelled, None),
            TurnOutcome::AwaitingHitl { .. } => (
                InvocationState::Failed,
                Some(qubit_protocol::DeliveryVerdict {
                    status: qubit_protocol::DeliveryStatus::Failed,
                    reasons: vec!["child_awaiting_hitl".into()],
                }),
            ),
        };

        // Prefer real child answer over a stub "invocation → child turn" line.
        let answer_text = self
            .store
            .get_session(&child_session.session_id)
            .await
            .ok()
            .and_then(|s| s.active_turn)
            .and_then(|t| t.answer_text)
            .filter(|s| !s.trim().is_empty());

        let handoff_out = Some(ContextHandoffV1 {
            version: 1,
            goal: req.goal.clone(),
            symbols: req
                .handoff_in
                .as_ref()
                .map(|h| h.symbols.clone())
                .unwrap_or_default(),
            asof: None,
            claims: vec![],
            finance_refs: Default::default(),
            evidence: None,
            debate: None,
            narrative: answer_text.or_else(|| {
                Some(format!(
                    "invocation {} → child turn {} (no answer_text)",
                    req.invocation_id, child_turn_id
                ))
            }),
        });

        let record = InvocationRecord {
            request: req.clone(),
            child_session_id: child_session.session_id,
            child_turn_id,
            state,
            handoff_out,
            delivery,
        };
        let _ = self
            .store
            .upsert_invocation(&req.parent_session_id, record.clone())
            .await;
        Ok(record)
    }
}

#[async_trait]
impl AgentInvoker for InvocationService {
    async fn invoke_agent(
        &self,
        req: InvocationRequest,
        cancel: CancelToken,
    ) -> Result<InvocationRecord, RuntimeError> {
        self.invoke(req, cancel).await
    }
}

fn build_isolated_goal(req: &InvocationRequest) -> String {
    let mut parts = vec![format!("[invoke goal]\n{}", req.goal)];
    if let Some(ref handoff) = req.handoff_in {
        if let Ok(j) = serde_json::to_string_pretty(handoff) {
            parts.push(format!("[handoff_in]\n{j}"));
        }
    }
    parts.push(
        "[isolation] This is an isolated child context. Do not assume parent transcript."
            .into(),
    );
    parts.join("\n\n")
}
