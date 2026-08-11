use std::collections::HashMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use qubit_protocol::{
    AgentInstance, AgentInstanceId, AgentInstanceStatus, AgentPlanSnapshot, AgentSpec, AgentSpecId,
    ExecutionKind, InteractionMode, InvocationRecord, ProtocolError, SessionId, SessionStatus,
    SessionView, TurnId, TurnState, TurnView, WorkspaceId,
};

use crate::core_db::CoreDb;
use crate::error::RuntimeError;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4().simple())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionRecord {
    pub view: SessionView,
    pub active_turn: Option<TurnView>,
    pub plan: Option<AgentPlanSnapshot>,
    /// Parent-session ledger of `agent.invoke` results (RPC + L0 tool path).
    #[serde(default)]
    pub invocations: Vec<InvocationRecord>,
}

pub struct MemoryStore {
    specs: RwLock<HashMap<String, AgentSpec>>,
    instances: RwLock<HashMap<String, AgentInstance>>,
    sessions: RwLock<HashMap<String, SessionRecord>>,
    /// When set, mutating ops also write through to Core SQLite.
    persist: Option<Arc<CoreDb>>,
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryStore {
    pub fn new() -> Self {
        Self {
            specs: RwLock::new(HashMap::new()),
            instances: RwLock::new(HashMap::new()),
            sessions: RwLock::new(HashMap::new()),
            persist: None,
        }
    }

    pub fn with_persist(db: Arc<CoreDb>) -> Self {
        Self {
            persist: Some(db),
            ..Self::new()
        }
    }

    /// Load specs / instances / sessions from CoreDb into memory (boot hydrate).
    pub async fn hydrate_from_db(&self) -> Result<usize, RuntimeError> {
        let Some(db) = &self.persist else {
            return Ok(0);
        };
        let db = Arc::clone(db);
        let (specs, instances, sessions) = tokio::task::spawn_blocking(move || {
            Ok::<_, RuntimeError>((db.list_specs()?, db.list_instances()?, db.list_sessions()?))
        })
        .await
        .map_err(|e| RuntimeError::Internal(format!("join: {e}")))??;

        let n = specs.len() + instances.len() + sessions.len();
        {
            let mut map = self.specs.write().await;
            for s in specs {
                map.insert(s.id.as_str().to_string(), s);
            }
        }
        {
            let mut map = self.instances.write().await;
            for (k, inst) in instances {
                map.insert(k, inst);
            }
        }
        {
            let mut map = self.sessions.write().await;
            for rec in sessions {
                map.insert(rec.view.session_id.as_str().to_string(), rec);
            }
        }
        Ok(n)
    }

    fn persist_spec(&self, spec: &AgentSpec) {
        if let Some(db) = &self.persist {
            if let Err(e) = db.upsert_spec(spec) {
                tracing::warn!(error = %e, "persist agent_spec failed");
            }
        }
    }

    fn persist_instance(&self, key: &str, inst: &AgentInstance) {
        if let Some(db) = &self.persist {
            if let Err(e) = db.upsert_instance(key, inst) {
                tracing::warn!(error = %e, "persist agent_instance failed");
            }
        }
    }

    fn persist_session(&self, rec: &SessionRecord) {
        if let Some(db) = &self.persist {
            if let Err(e) = db.upsert_session(rec) {
                tracing::warn!(error = %e, "persist session failed");
            }
        }
    }

    pub async fn upsert_spec(&self, spec: AgentSpec) {
        self.persist_spec(&spec);
        self.specs
            .write()
            .await
            .insert(spec.id.as_str().to_string(), spec);
    }

    pub async fn get_spec(&self, id: &AgentSpecId) -> Result<AgentSpec, RuntimeError> {
        self.specs
            .read()
            .await
            .get(id.as_str())
            .cloned()
            .ok_or_else(|| {
                ProtocolError::NotFound {
                    resource: format!("agent_spec {}", id),
                }
                .into()
            })
    }

    pub async fn list_specs(&self) -> Vec<AgentSpec> {
        self.specs.read().await.values().cloned().collect()
    }

    pub async fn ensure_instance(
        &self,
        spec: &AgentSpec,
        workspace_id: WorkspaceId,
    ) -> Result<AgentInstance, RuntimeError> {
        let key = format!("{}:{}", workspace_id, spec.id);
        {
            let map = self.instances.read().await;
            if let Some(inst) = map.get(&key) {
                return Ok(inst.clone());
            }
        }
        let inst = AgentInstance {
            instance_id: AgentInstanceId::new(new_id("inst_")),
            spec_id: spec.id.clone(),
            workspace_id,
            parent_instance_id: None,
            status: AgentInstanceStatus::Ready,
        };
        self.persist_instance(&key, &inst);
        self.instances.write().await.insert(key, inst.clone());
        Ok(inst)
    }

    pub async fn create_session(
        &self,
        workspace_id: WorkspaceId,
        instance: &AgentInstance,
        spec: &AgentSpec,
        interaction_mode: InteractionMode,
    ) -> SessionView {
        let ts = now_ms();
        let view = SessionView {
            session_id: SessionId::new(new_id("ses_")),
            workspace_id,
            agent_instance_id: instance.instance_id.clone(),
            agent_spec_id: spec.id.clone(),
            execution_kind: spec.execution_kind,
            interaction_mode,
            status: SessionStatus::Active,
            created_at_ms: ts,
            updated_at_ms: ts,
            event_seq: 0,
        };
        let rec = SessionRecord {
            view: view.clone(),
            active_turn: None,
            plan: None,
            invocations: Vec::new(),
        };
        self.persist_session(&rec);
        self.sessions
            .write()
            .await
            .insert(view.session_id.as_str().to_string(), rec);
        view
    }

    pub async fn get_session(&self, id: &SessionId) -> Result<SessionRecord, RuntimeError> {
        self.sessions
            .read()
            .await
            .get(id.as_str())
            .cloned()
            .ok_or_else(|| {
                ProtocolError::NotFound {
                    resource: format!("session {}", id),
                }
                .into()
            })
    }

    pub async fn set_interaction_mode(
        &self,
        id: &SessionId,
        mode: InteractionMode,
    ) -> Result<SessionView, RuntimeError> {
        let snapshot = {
            let mut map = self.sessions.write().await;
            let rec = map.get_mut(id.as_str()).ok_or_else(|| {
                RuntimeError::from(ProtocolError::NotFound {
                    resource: format!("session {id}"),
                })
            })?;
            rec.view.interaction_mode = mode;
            rec.view.updated_at_ms = now_ms();
            rec.clone()
        };
        self.persist_session(&snapshot);
        Ok(snapshot.view)
    }

    pub async fn set_active_turn(
        &self,
        session_id: &SessionId,
        turn: Option<TurnView>,
    ) -> Result<(), RuntimeError> {
        let snapshot = {
            let mut map = self.sessions.write().await;
            let rec = map
                .get_mut(session_id.as_str())
                .ok_or_else(|| ProtocolError::NotFound {
                    resource: format!("session {session_id}"),
                })?;
            rec.view.updated_at_ms = now_ms();
            rec.active_turn = turn;
            rec.clone()
        };
        self.persist_session(&snapshot);
        Ok(())
    }

    pub async fn bump_event_seq(
        &self,
        session_id: &SessionId,
        seq: u64,
    ) -> Result<(), RuntimeError> {
        let snapshot = {
            let mut map = self.sessions.write().await;
            let rec = map
                .get_mut(session_id.as_str())
                .ok_or_else(|| ProtocolError::NotFound {
                    resource: format!("session {session_id}"),
                })?;
            rec.view.event_seq = seq;
            rec.view.updated_at_ms = now_ms();
            rec.clone()
        };
        self.persist_session(&snapshot);
        Ok(())
    }

    pub async fn set_plan(
        &self,
        session_id: &SessionId,
        plan: Option<AgentPlanSnapshot>,
    ) -> Result<(), RuntimeError> {
        let snapshot = {
            let mut map = self.sessions.write().await;
            let rec = map
                .get_mut(session_id.as_str())
                .ok_or_else(|| ProtocolError::NotFound {
                    resource: format!("session {session_id}"),
                })?;
            rec.plan = plan;
            rec.view.updated_at_ms = now_ms();
            rec.clone()
        };
        self.persist_session(&snapshot);
        Ok(())
    }

    pub async fn get_plan(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<AgentPlanSnapshot>, RuntimeError> {
        Ok(self.get_session(session_id).await?.plan)
    }

    /// Insert or replace an invocation record keyed by `request.invocation_id`.
    pub async fn upsert_invocation(
        &self,
        session_id: &SessionId,
        record: InvocationRecord,
    ) -> Result<(), RuntimeError> {
        let snapshot = {
            let mut map = self.sessions.write().await;
            let rec = map
                .get_mut(session_id.as_str())
                .ok_or_else(|| ProtocolError::NotFound {
                    resource: format!("session {session_id}"),
                })?;
            let id = record.request.invocation_id.as_str();
            if let Some(slot) = rec
                .invocations
                .iter_mut()
                .find(|r| r.request.invocation_id.as_str() == id)
            {
                *slot = record;
            } else {
                rec.invocations.push(record);
            }
            rec.view.updated_at_ms = now_ms();
            rec.clone()
        };
        self.persist_session(&snapshot);
        Ok(())
    }
}

pub fn seed_primary_spec() -> AgentSpec {
    AgentSpec {
        id: AgentSpecId::new("def-primary"),
        version: "0.1.0".into(),
        display_name: "Primary".into(),
        execution_kind: ExecutionKind::Primary,
        labels: vec!["orchestrator".into()],
        identity_prompt_ref: "prompts/primary.md".into(),
        system_prompt: None,
        default_recipe_id: Some("open".into()),
        tool_surface_ref: "surfaces/default".into(),
        model_ref: None,
        max_iterations: 8,
        hitl_profile_ref: None,
        allowed_callers: vec![],
        triggers: vec![],
        enabled: true,
    }
}

pub fn seed_research_subagent_spec() -> AgentSpec {
    AgentSpec {
        id: AgentSpecId::new("def-research-sub"),
        version: "0.1.0".into(),
        display_name: "Research Subagent".into(),
        execution_kind: ExecutionKind::Subagent,
        labels: vec!["research".into()],
        identity_prompt_ref: "prompts/research.md".into(),
        system_prompt: None,
        default_recipe_id: Some("open".into()),
        tool_surface_ref: "surfaces/research".into(),
        model_ref: None,
        max_iterations: 4,
        hitl_profile_ref: None,
        allowed_callers: vec![],
        triggers: vec![],
        enabled: true,
    }
}

pub fn seed_news_reactor_spec() -> AgentSpec {
    use qubit_protocol::TriggerSpec;
    AgentSpec {
        id: AgentSpecId::new("def-news-reactor"),
        version: "0.1.0".into(),
        display_name: "News Reactor".into(),
        execution_kind: ExecutionKind::Reactor,
        labels: vec!["reactor".into(), "news".into()],
        identity_prompt_ref: "prompts/reactor.md".into(),
        system_prompt: None,
        default_recipe_id: Some("open".into()),
        tool_surface_ref: "surfaces/reactor".into(),
        model_ref: None,
        max_iterations: 2,
        hitl_profile_ref: None,
        allowed_callers: vec![],
        triggers: vec![TriggerSpec::DomainEvent {
            event_name: "market.news".into(),
        }],
        enabled: true,
    }
}

pub fn new_turn_id() -> TurnId {
    TurnId::new(new_id("trn_"))
}

pub fn initial_turn(turn_id: TurnId) -> TurnView {
    TurnView {
        turn_id,
        state: TurnState::Accepted,
        iteration: 0,
        lifecycle: None,
        delivery: None,
        answer_text: None,
        llm_stats: None,
    }
}

pub type SharedStore = Arc<MemoryStore>;
