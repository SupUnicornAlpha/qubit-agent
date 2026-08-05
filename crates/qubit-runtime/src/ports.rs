//! Facade implementing CoreRuntime semantics (M6: cancel / supervisor / trigger).

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use qubit_protocol::{
    AgentListResult, HitlInboxFilter, HitlInboxItem, HitlInboxStatus, HitlRespond, InvocationRecord,
    InvocationRequest, RuntimeEvent, RuntimeHealth, SessionCreate, SessionGet, SessionSetMode,
    SessionView, TriggerEvent, TurnCancel, TurnId, TurnStart, TurnStartResult, TurnState,
};

use crate::admission::{AgentAdmission, DefaultAdmission};
use crate::bridge_host::{BridgeToolHost, CompositeToolHost};
use crate::cancel::CancelToken;
use crate::cancel_registry::TurnCancelRegistry;
use crate::checkpoint::{CheckpointStore, SqliteCheckpointStore};
use crate::context::{
    BridgeRecallPort, BridgeWorkspacePort, ContextAssembler, DefaultContextAssembler,
    StaticIdentityLoader,
};
use crate::core_db::{default_core_db_path, CoreDb};
use crate::engine::{RunTurnOpts, TurnEngine};
use crate::error::RuntimeError;
use crate::events::EventBus;
use crate::hitl_inbox::{HitlInbox, MemoryHitlInbox, SqliteHitlInbox};
use crate::invocation::InvocationService;
use crate::model::{FakeModelClient, ModelClient};
use crate::session::SessionManager;
use crate::store::{
    new_turn_id, seed_news_reactor_spec, seed_primary_spec, seed_research_subagent_spec,
    MemoryStore, SharedStore,
};
use crate::supervisor::{RuntimeLimits, TurnSupervisor};
use crate::tools::{FakeToolHost, L0ToolHost, ToolHost};
use crate::trigger::{TriggerIngress, TriggerIngressService};
use qubit_tool_host::{LegacyBridgeClient, LegacyBridgeConfig};

/// Result of an abortable turn start (M6).
pub struct StartedTurn {
    pub turn_id: TurnId,
    pub abort: tokio::task::AbortHandle,
}

pub struct CoreRuntimeService {
    store: SharedStore,
    sessions: SessionManager,
    engine: Arc<TurnEngine>,
    invocation: Arc<InvocationService>,
    triggers: TriggerIngressService,
    hitl: Arc<dyn HitlInbox>,
    checkpoints: Option<Arc<dyn CheckpointStore>>,
    cancels: TurnCancelRegistry,
    supervisor: TurnSupervisor,
    started: Instant,
    /// True when Core is running FakeModelClient (no real LLM).
    fake_model: bool,
    _admission: Arc<dyn AgentAdmission>,
}

impl CoreRuntimeService {
    pub fn new_for_test() -> Self {
        Self::build(None, None, RuntimeLimits::default())
    }

    pub fn new_with_limits(limits: RuntimeLimits) -> Self {
        Self::build(None, None, limits)
    }

    pub fn new_with_sqlite(path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        let db = Arc::new(CoreDb::open(path)?);
        Ok(Self::build(Some(db), None, RuntimeLimits::default()))
    }

    pub fn new_with_sqlite_and_model(
        path: impl AsRef<Path>,
        models: Arc<dyn ModelClient>,
    ) -> Result<Self, RuntimeError> {
        let db = Arc::new(CoreDb::open(path)?);
        Ok(Self::build(Some(db), Some(models), RuntimeLimits::default()))
    }

    /// Open default Core DB (`QUBIT_CORE_DB` / `~/.qubit/core/runtime.sqlite`) + model.
    pub fn new_with_default_db_and_model(
        models: Arc<dyn ModelClient>,
    ) -> Result<Self, RuntimeError> {
        Self::new_with_sqlite_and_model(default_core_db_path(), models)
    }

    pub fn new_with_default_db() -> Result<Self, RuntimeError> {
        Self::new_with_sqlite(default_core_db_path())
    }

    pub fn new_with_model(models: Arc<dyn ModelClient>) -> Self {
        Self::build(None, Some(models), RuntimeLimits::default())
    }

    pub fn new_with_model_and_limits(
        models: Arc<dyn ModelClient>,
        limits: RuntimeLimits,
    ) -> Self {
        Self::build(None, Some(models), limits)
    }

    fn build(
        core_db: Option<Arc<CoreDb>>,
        models: Option<Arc<dyn ModelClient>>,
        limits: RuntimeLimits,
    ) -> Self {
        let store: SharedStore = if let Some(ref db) = core_db {
            Arc::new(MemoryStore::with_persist(Arc::clone(db)))
        } else {
            Arc::new(MemoryStore::new())
        };
        let events = EventBus::new(limits.event_bus_capacity);
        let hitl: Arc<dyn HitlInbox> = if let Some(ref db) = core_db {
            Arc::new(SqliteHitlInbox::new(Arc::clone(db)))
        } else {
            Arc::new(MemoryHitlInbox::new())
        };
        let checkpoints: Option<Arc<dyn CheckpointStore>> = core_db.as_ref().map(|db| {
            Arc::new(SqliteCheckpointStore::from_db(Arc::clone(db))) as Arc<dyn CheckpointStore>
        });
        let fake_model = models.is_none();
        let models: Arc<dyn ModelClient> =
            models.unwrap_or_else(|| Arc::new(FakeModelClient) as Arc<dyn ModelClient>);
        let fallback: Arc<dyn ToolHost> = Arc::new(FakeToolHost);

        let (bridge, bridge_client) = if let Some(cfg) = LegacyBridgeConfig::from_env() {
            match LegacyBridgeClient::new(cfg) {
                Ok(client) => {
                    tracing::info!("legacy bridge enabled via QUBIT_LEGACY_BRIDGE_URL");
                    let client = Arc::new(client);
                    let host = Arc::new(BridgeToolHost::from_shared(Arc::clone(&client)));
                    (Some(host), Some(client))
                }
                Err(e) => {
                    tracing::warn!(error = %e, "failed to init legacy bridge");
                    (None, None)
                }
            }
        } else {
            (None, None)
        };

        let l0 = Arc::new(L0ToolHost::new(Arc::clone(&store), Arc::clone(&fallback)));
        let tools: Arc<dyn ToolHost> = Arc::new(CompositeToolHost::new(
            Arc::clone(&l0) as Arc<dyn ToolHost>,
            bridge,
            Arc::clone(&fallback),
        ));
        let admission: Arc<dyn AgentAdmission> = Arc::new(DefaultAdmission);
        let context: Arc<dyn ContextAssembler> = if let Some(client) = bridge_client {
            Arc::new(DefaultContextAssembler::new(
                Arc::new(BridgeRecallPort::new(Arc::clone(&client))),
                Arc::new(BridgeWorkspacePort::new(client)),
                Arc::new(StaticIdentityLoader),
            ))
        } else {
            Arc::new(DefaultContextAssembler::with_empty_ports(Arc::new(
                StaticIdentityLoader,
            )))
        };
        let supervisor = TurnSupervisor::new(limits);
        let mut engine = TurnEngine::new(
            Arc::clone(&store),
            models,
            tools,
            events,
            Arc::clone(&hitl),
        )
        .with_context(context)
        .with_l0(Arc::clone(&l0));
        if let Some(ref cp) = checkpoints {
            engine = engine.with_checkpoints(Arc::clone(cp));
        }
        let engine = Arc::new(engine);
        let invocation = Arc::new(InvocationService::new(
            Arc::clone(&store),
            Arc::clone(&admission),
            Arc::clone(&engine),
        ));
        // Late-bind so L0 `agent.invoke` can call the same service without a build cycle.
        l0.bind_invoker(Arc::clone(&invocation) as Arc<dyn crate::invocation::AgentInvoker>);
        let triggers = TriggerIngressService::new(
            Arc::clone(&store),
            Arc::clone(&admission),
            Arc::clone(&engine),
            supervisor.clone(),
        );
        let sessions = SessionManager::new(Arc::clone(&store), Arc::clone(&admission));
        Self {
            store,
            sessions,
            engine,
            invocation,
            triggers,
            hitl,
            checkpoints,
            cancels: TurnCancelRegistry::new(),
            supervisor,
            started: Instant::now(),
            fake_model,
            _admission: admission,
        }
    }

    pub async fn seed_defaults(&self) {
        self.store.upsert_spec(seed_primary_spec()).await;
        self.store.upsert_spec(seed_research_subagent_spec()).await;
        self.store.upsert_spec(seed_news_reactor_spec()).await;
    }

    pub async fn upsert_agent_spec(&self, spec: qubit_protocol::AgentSpec) {
        self.store.upsert_spec(spec).await;
    }

    pub fn event_bus(&self) -> &EventBus {
        self.engine.events()
    }

    pub fn store(&self) -> &MemoryStore {
        &self.store
    }

    pub fn supervisor(&self) -> &TurnSupervisor {
        &self.supervisor
    }

    /// Hydrate Session store from SQLite; HITL already reads from SQLite when durable.
    /// Returns count of pending HITL + non-terminal AwaitingHitl turns (not hydrate row count).
    pub async fn recover_on_boot(&self) -> Result<usize, RuntimeError> {
        let _hydrated = self.store.hydrate_from_db().await?;
        let Some(cp) = &self.checkpoints else {
            return Ok(0);
        };
        // SqliteHitlInbox is authoritative — no re-enqueue into a second memory inbox.
        let pending = cp.list_pending_hitl().await?;
        let non_term = cp.list_non_terminal().await?;
        let mut n = pending.len();
        for rec in non_term {
            if rec.state == TurnState::AwaitingHitl {
                n += 1;
            }
        }
        Ok(n)
    }

    pub async fn create_session(&self, req: SessionCreate) -> Result<SessionView, RuntimeError> {
        self.sessions.create_session(req).await
    }

    pub async fn get_session(&self, req: SessionGet) -> Result<SessionView, RuntimeError> {
        self.sessions.get_session(&req.session_id).await
    }

    pub async fn set_session_mode(&self, req: SessionSetMode) -> Result<SessionView, RuntimeError> {
        self.sessions
            .set_interaction_mode(&req.session_id, req.interaction_mode)
            .await
    }

    pub async fn session_snapshot(
        &self,
        req: SessionGet,
    ) -> Result<qubit_protocol::SessionSnapshot, RuntimeError> {
        let rec = self.store.get_session(&req.session_id).await?;
        Ok(qubit_protocol::SessionSnapshot {
            session: rec.view,
            active_turn: rec.active_turn,
            plan: rec.plan,
            invocations: rec.invocations,
        })
    }

    /// Fire-and-forget turn start: returns `turn_id` immediately so `turn.cancel` can race.
    pub async fn start_turn(&self, req: TurnStart) -> Result<TurnStartResult, RuntimeError> {
        let started = self.start_turn_abortable(req).await?;
        Ok(TurnStartResult {
            turn_id: started.turn_id,
        })
    }

    /// Like [`Self::start_turn`], but returns an abort handle (M6 kill-9 / soak).
    pub async fn start_turn_abortable(
        &self,
        req: TurnStart,
    ) -> Result<StartedTurn, RuntimeError> {
        let permit = self.supervisor.try_acquire()?;
        let turn_id = new_turn_id();
        let token = CancelToken::new();
        self.cancels.insert(&turn_id, token.clone()).await;

        let engine = Arc::clone(&self.engine);
        let cancels = self.cancels.clone();
        let session_id = req.session_id;
        let input = req.input;
        let tid = turn_id.clone();

        let join = tokio::spawn(async move {
            let _permit = permit;
            let result = engine
                .run_turn_preallocated(
                    &session_id,
                    tid.clone(),
                    input,
                    token,
                    RunTurnOpts::default(),
                )
                .await;
            if let Err(e) = result {
                tracing::error!(turn_id = %tid, error = %e, "turn task failed");
                if let Err(fail_err) = engine.fail_turn(&session_id, &tid, &e).await {
                    tracing::error!(
                        turn_id = %tid,
                        error = %fail_err,
                        "failed to mark turn as failed after error"
                    );
                }
            }
            cancels.remove(&tid).await;
        });
        let abort = join.abort_handle();
        self.cancels.set_abort(&turn_id, abort.clone()).await;

        Ok(StartedTurn { turn_id, abort })
    }

    /// Block until the turn reaches a terminal event (or timeout).
    pub async fn await_turn_terminal(
        &self,
        turn_id: &TurnId,
        timeout: Duration,
    ) -> Result<RuntimeEvent, RuntimeError> {
        let mut rx = self.event_bus().subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return Err(RuntimeError::Internal(format!(
                    "timeout waiting for turn {}",
                    turn_id
                )));
            }
            match tokio::time::timeout(left, rx.recv()).await {
                Ok(Ok(ev)) => match &ev {
                    RuntimeEvent::TurnCompleted { turn_id: tid, .. }
                    | RuntimeEvent::TurnFailed { turn_id: tid, .. }
                        if tid == turn_id =>
                    {
                        return Ok(ev);
                    }
                    _ => continue,
                },
                Ok(Err(e)) => {
                    return Err(RuntimeError::Internal(format!("event recv: {e}")));
                }
                Err(_) => {
                    return Err(RuntimeError::Internal(format!(
                        "timeout waiting for turn {}",
                        turn_id
                    )));
                }
            }
        }
    }

    pub async fn cancel_turn(&self, req: TurnCancel) -> Result<(), RuntimeError> {
        let found = self.cancels.cancel(&req.turn_id).await;
        if !found {
            // Best-effort: turn may have already finished.
            tracing::debug!(turn_id = %req.turn_id, "cancel: token not registered (already done?)");
        }
        Ok(())
    }

    pub async fn respond_hitl(&self, req: HitlRespond) -> Result<(), RuntimeError> {
        let item = self.hitl.respond(req.clone()).await?;
        if let Some(cp) = &self.checkpoints {
            let status = if req.approved {
                HitlInboxStatus::Approved
            } else {
                HitlInboxStatus::Rejected
            };
            cp.update_hitl_status(item.inbox_id.as_str(), status).await?;
        }
        Ok(())
    }

    pub async fn list_hitl_inbox(
        &self,
        filter: HitlInboxFilter,
    ) -> Result<Vec<HitlInboxItem>, RuntimeError> {
        self.hitl.list_pending(filter).await
    }

    pub async fn invoke_agent(
        &self,
        req: InvocationRequest,
    ) -> Result<InvocationRecord, RuntimeError> {
        let _permit = self.supervisor.try_acquire()?;
        let token = CancelToken::new();
        // Child turn id is registered inside InvocationService once allocated.
        self.invocation
            .invoke_registered(req, token, Some(&self.cancels))
            .await
    }

    pub async fn ingest_trigger(
        &self,
        event: TriggerEvent,
    ) -> Result<Option<String>, RuntimeError> {
        self.triggers.ingest(event).await
    }

    pub async fn list_agents(&self) -> AgentListResult {
        AgentListResult {
            agents: self.store.list_specs().await,
        }
    }

    pub async fn health(&self) -> RuntimeHealth {
        let mut degraded = vec![];
        let dropped = self.event_bus().dropped_count();
        if dropped > 0 {
            degraded.push(format!("event_bus_lag_drops={dropped}"));
        }
        if self.fake_model {
            degraded.push("fake_model".into());
        }
        let llm_model = std::env::var("QUBIT_LLM_MODEL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let llm_base_url = std::env::var("QUBIT_LLM_BASE_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let has_llm_key = std::env::var("QUBIT_LLM_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                std::env::var("OPENAI_API_KEY")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
            })
            .is_some();

        RuntimeHealth {
            status: if degraded.is_empty() {
                "ok".into()
            } else {
                "degraded".into()
            },
            uptime_ms: self.started.elapsed().as_millis() as u64,
            active_turns: self.supervisor.active_turns(),
            hitl_waiting: self
                .hitl
                .list_pending(HitlInboxFilter {
                    pending_only: true,
                    ..Default::default()
                })
                .await
                .map(|v| v.len() as u32)
                .unwrap_or(0),
            core_backend: "rust".into(),
            degraded_reasons: degraded,
            llm_model,
            llm_base_url,
            has_llm_key,
        }
    }
}
