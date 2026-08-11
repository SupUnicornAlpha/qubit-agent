//! Checkpoint persistence (01 §6.5 / §9) — desktop HA. Backed by [`CoreDb`].

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use qubit_protocol::{
    HitlInboxItem, HitlInboxStatus, SessionId, SessionView, TurnId, TurnState, TurnView,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::core_db::CoreDb;
use crate::error::RuntimeError;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CheckpointRecord {
    pub session_id: SessionId,
    pub turn_id: TurnId,
    pub seq: u64,
    pub state: TurnState,
    pub iteration: u32,
    pub turn: TurnView,
    pub session: SessionView,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hitl: Option<HitlInboxItem>,
    pub updated_at_ms: i64,
}

#[async_trait]
pub trait CheckpointStore: Send + Sync {
    async fn save(&self, record: &CheckpointRecord) -> Result<(), RuntimeError>;
    async fn load_turn(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
    ) -> Result<Option<CheckpointRecord>, RuntimeError>;
    async fn list_non_terminal(&self) -> Result<Vec<CheckpointRecord>, RuntimeError>;
    async fn save_hitl(&self, item: &HitlInboxItem) -> Result<(), RuntimeError>;
    async fn list_pending_hitl(&self) -> Result<Vec<HitlInboxItem>, RuntimeError>;
    async fn update_hitl_status(
        &self,
        inbox_id: &str,
        status: HitlInboxStatus,
    ) -> Result<(), RuntimeError>;
}

#[derive(Clone)]
pub struct SqliteCheckpointStore {
    db: Arc<CoreDb>,
}

impl SqliteCheckpointStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        Ok(Self {
            db: Arc::new(CoreDb::open(path)?),
        })
    }

    pub fn from_db(db: Arc<CoreDb>) -> Self {
        Self { db }
    }

    pub fn db(&self) -> Arc<CoreDb> {
        Arc::clone(&self.db)
    }

    pub fn path(&self) -> &Path {
        self.db.path()
    }
}

fn is_terminal(state: TurnState) -> bool {
    matches!(
        state,
        TurnState::Completed | TurnState::Failed | TurnState::Cancelled
    )
}

#[async_trait]
impl CheckpointStore for SqliteCheckpointStore {
    async fn save(&self, record: &CheckpointRecord) -> Result<(), RuntimeError> {
        let conn = self.db.conn();
        let record = record.clone();
        tokio::task::spawn_blocking(move || {
            let json = serde_json::to_string(&record)
                .map_err(|e| RuntimeError::Internal(e.to_string()))?;
            let state = serde_json::to_value(record.state)
                .ok()
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .unwrap_or_else(|| format!("{:?}", record.state));
            let g = conn
                .lock()
                .map_err(|_| RuntimeError::Internal("checkpoint lock".into()))?;
            g.execute(
                "INSERT INTO checkpoints(session_id, turn_id, seq, state, iteration, payload_json, updated_at_ms)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(session_id, turn_id) DO UPDATE SET
                   seq=excluded.seq,
                   state=excluded.state,
                   iteration=excluded.iteration,
                   payload_json=excluded.payload_json,
                   updated_at_ms=excluded.updated_at_ms",
                params![
                    record.session_id.as_str(),
                    record.turn_id.as_str(),
                    record.seq as i64,
                    state,
                    record.iteration as i64,
                    json,
                    record.updated_at_ms,
                ],
            )
            .map_err(|e| RuntimeError::Internal(format!("checkpoint save: {e}")))?;
            Ok(())
        })
        .await
        .map_err(|e| RuntimeError::Internal(format!("join: {e}")))?
    }

    async fn load_turn(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
    ) -> Result<Option<CheckpointRecord>, RuntimeError> {
        let conn = self.db.conn();
        let sid = session_id.as_str().to_string();
        let tid = turn_id.as_str().to_string();
        tokio::task::spawn_blocking(move || {
            let g = conn
                .lock()
                .map_err(|_| RuntimeError::Internal("checkpoint lock".into()))?;
            let json: Option<String> = g
                .query_row(
                    "SELECT payload_json FROM checkpoints WHERE session_id=?1 AND turn_id=?2",
                    params![sid, tid],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| RuntimeError::Internal(format!("load: {e}")))?;
            match json {
                Some(j) => Ok(Some(
                    serde_json::from_str(&j).map_err(|e| RuntimeError::Internal(e.to_string()))?,
                )),
                None => Ok(None),
            }
        })
        .await
        .map_err(|e| RuntimeError::Internal(format!("join: {e}")))?
    }

    async fn list_non_terminal(&self) -> Result<Vec<CheckpointRecord>, RuntimeError> {
        let conn = self.db.conn();
        tokio::task::spawn_blocking(move || {
            let g = conn
                .lock()
                .map_err(|_| RuntimeError::Internal("checkpoint lock".into()))?;
            let mut stmt = g
                .prepare("SELECT payload_json FROM checkpoints")
                .map_err(|e| RuntimeError::Internal(e.to_string()))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| RuntimeError::Internal(e.to_string()))?;
            let mut out = Vec::new();
            for r in rows {
                let json = r.map_err(|e| RuntimeError::Internal(e.to_string()))?;
                let rec: CheckpointRecord = serde_json::from_str(&json)
                    .map_err(|e| RuntimeError::Internal(e.to_string()))?;
                if !is_terminal(rec.state) {
                    out.push(rec);
                }
            }
            Ok(out)
        })
        .await
        .map_err(|e| RuntimeError::Internal(format!("join: {e}")))?
    }

    async fn save_hitl(&self, item: &HitlInboxItem) -> Result<(), RuntimeError> {
        let db = Arc::clone(&self.db);
        let item = item.clone();
        tokio::task::spawn_blocking(move || db.save_hitl(&item))
            .await
            .map_err(|e| RuntimeError::Internal(format!("join: {e}")))?
    }

    async fn list_pending_hitl(&self) -> Result<Vec<HitlInboxItem>, RuntimeError> {
        let db = Arc::clone(&self.db);
        tokio::task::spawn_blocking(move || db.list_hitl(true))
            .await
            .map_err(|e| RuntimeError::Internal(format!("join: {e}")))?
    }

    async fn update_hitl_status(
        &self,
        inbox_id: &str,
        status: HitlInboxStatus,
    ) -> Result<(), RuntimeError> {
        let db = Arc::clone(&self.db);
        let inbox_id = inbox_id.to_string();
        tokio::task::spawn_blocking(move || {
            let mut item = db
                .get_hitl(&inbox_id)?
                .ok_or_else(|| RuntimeError::Internal(format!("hitl get: missing {inbox_id}")))?;
            item.status = status;
            db.update_hitl(&item)
        })
        .await
        .map_err(|e| RuntimeError::Internal(format!("join: {e}")))?
    }
}

pub type CheckpointDbPath = PathBuf;
