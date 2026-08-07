//! TriggerIngress — reactor wake-up (01 §6.7 / M6).

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use qubit_protocol::{
    ExecutionKind, InteractionMode, ProtocolError, TriggerEvent, TriggerSpec, UserInput,
    WorkspaceId,
};
use tokio::sync::RwLock;
use tracing::info;

use crate::admission::AgentAdmission;
use crate::cancel::CancelToken;
use crate::engine::{RunTurnOpts, TurnEngine, TurnOutcome};
use crate::error::RuntimeError;
use crate::store::SharedStore;
use crate::supervisor::TurnSupervisor;

#[async_trait]
pub trait TriggerIngress: Send + Sync {
    async fn ingest(&self, event: TriggerEvent) -> Result<Option<String>, RuntimeError>;
}

pub struct TriggerIngressService {
    store: SharedStore,
    admission: Arc<dyn AgentAdmission>,
    engine: Arc<TurnEngine>,
    supervisor: TurnSupervisor,
    /// event_id → turn_id (idempotency).
    seen: Arc<RwLock<HashMap<String, String>>>,
}

impl TriggerIngressService {
    pub fn new(
        store: SharedStore,
        admission: Arc<dyn AgentAdmission>,
        engine: Arc<TurnEngine>,
        supervisor: TurnSupervisor,
    ) -> Self {
        Self {
            store,
            admission,
            engine,
            supervisor,
            seen: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    async fn resolve_reactor(
        &self,
        event: &TriggerEvent,
    ) -> Result<qubit_protocol::AgentSpec, RuntimeError> {
        if let Some(ref spec_id) = event.target_spec_id {
            let spec = self.store.get_spec(spec_id).await?;
            self.admission.admit_trigger(&spec, event)?;
            return Ok(spec);
        }

        let specs = self.store.list_specs().await;
        let mut matches = Vec::new();
        for spec in specs {
            if spec.execution_kind != ExecutionKind::Reactor || !spec.enabled {
                continue;
            }
            if spec.triggers.iter().any(|t| trigger_matches(t, &event.source)) {
                matches.push(spec);
            }
        }
        match matches.len() {
            0 => Err(ProtocolError::NotFound {
                resource: "reactor matching trigger".into(),
            }
            .into()),
            1 => {
                let spec = matches.remove(0);
                self.admission.admit_trigger(&spec, event)?;
                Ok(spec)
            }
            _ => Err(ProtocolError::Conflict {
                message: format!(
                    "ambiguous reactor match ({} candidates); set target_spec_id",
                    matches.len()
                ),
            }
            .into()),
        }
    }
}

#[async_trait]
impl TriggerIngress for TriggerIngressService {
    async fn ingest(&self, event: TriggerEvent) -> Result<Option<String>, RuntimeError> {
        let eid = event.event_id.as_str().to_string();
        if let Some(prev) = self.seen.read().await.get(&eid) {
            info!(event_id = %eid, turn_id = %prev, "trigger idempotent hit");
            return Ok(Some(prev.clone()));
        }

        let _permit = self.supervisor.try_acquire()?;
        let spec = self.resolve_reactor(&event).await?;
        let workspace_id = event
            .workspace_id
            .clone()
            .unwrap_or_else(|| WorkspaceId::new("ws_default"));
        let instance = self
            .store
            .ensure_instance(&spec, workspace_id.clone())
            .await?;
        let session = self
            .store
            .create_session(
                workspace_id,
                &instance,
                &spec,
                InteractionMode::Agent,
            )
            .await;

        let goal = format!(
            "[reactor trigger]\nevent_id={}\ncorrelation={:?}\npayload={}",
            event.event_id,
            event.correlation_id,
            event.payload
        );

        let (turn_id, outcome) = self
            .engine
            .run_turn_with_opts(
                &session.session_id,
                UserInput {
                    text: goal,
                    attachments: vec![],
                    client_meta: Some(serde_json::json!({
                        "source": "trigger.ingest",
                        "event_id": event.event_id.as_str(),
                    })),
                },
                CancelToken::new(),
                RunTurnOpts {
                    max_iterations: Some(spec.max_iterations.min(4).max(1)),
                    recipe_key: spec.default_recipe_id.clone().or_else(|| Some("open".into())),
                    ..Default::default()
                },
            )
            .await?;

        match outcome {
            TurnOutcome::Finished { .. } | TurnOutcome::Cancelled => {}
            TurnOutcome::AwaitingHitl { .. } => {
                // HITL goes to inbox; turn_id still returned.
            }
        }

        let tid = turn_id.as_str().to_string();
        self.seen.write().await.insert(eid, tid.clone());
        Ok(Some(tid))
    }
}

fn trigger_matches(configured: &TriggerSpec, incoming: &TriggerSpec) -> bool {
    match (configured, incoming) {
        (TriggerSpec::Queue { topic: a, .. }, TriggerSpec::Queue { topic: b, .. }) => a == b,
        (TriggerSpec::A2a { capability: a }, TriggerSpec::A2a { capability: b }) => a == b,
        (TriggerSpec::Webhook { path: a, .. }, TriggerSpec::Webhook { path: b, .. }) => a == b,
        (TriggerSpec::DomainEvent { event_name: a }, TriggerSpec::DomainEvent { event_name: b }) => {
            a == b
        }
        (TriggerSpec::Schedule { cron: a }, TriggerSpec::Schedule { cron: b }) => a == b,
        _ => false,
    }
}
