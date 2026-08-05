use std::sync::Arc;

use qubit_protocol::{InteractionMode, SessionCreate, SessionId, SessionView, WorkspaceId};

use crate::admission::AgentAdmission;
use crate::error::RuntimeError;
use crate::store::{MemoryStore, SharedStore};

pub struct SessionManager {
    store: SharedStore,
    admission: Arc<dyn AgentAdmission>,
}

impl SessionManager {
    pub fn new(store: SharedStore, admission: Arc<dyn AgentAdmission>) -> Self {
        Self { store, admission }
    }

    pub fn store(&self) -> &MemoryStore {
        &self.store
    }

    pub async fn create_session(&self, req: SessionCreate) -> Result<SessionView, RuntimeError> {
        let spec = self.store.get_spec(&req.agent_ref).await?;
        self.admission.admit_user_turn(&spec)?;
        let mode = req.resolved_interaction_mode();
        let workspace_id = req
            .workspace_id
            .unwrap_or_else(|| WorkspaceId::new("ws_default"));
        let instance = self.store.ensure_instance(&spec, workspace_id.clone()).await?;
        Ok(self
            .store
            .create_session(workspace_id, &instance, &spec, mode)
            .await)
    }

    pub async fn get_session(&self, session_id: &SessionId) -> Result<SessionView, RuntimeError> {
        Ok(self.store.get_session(session_id).await?.view)
    }

    pub async fn set_interaction_mode(
        &self,
        session_id: &SessionId,
        mode: InteractionMode,
    ) -> Result<SessionView, RuntimeError> {
        self.store.set_interaction_mode(session_id, mode).await
    }
}
