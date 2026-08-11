//! Shared SQLite for Core Session / HITL / Checkpoint (01 §6.5 · 05 S5).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::RuntimeError;
use crate::store::SessionRecord;
use qubit_protocol::{AgentInstance, AgentSpec, HitlInboxItem, HitlInboxStatus, SessionId};
use rusqlite::{params, Connection, OptionalExtension};

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Shared Core database (WAL). Used by checkpoint, durable store, and HITL inbox.
#[derive(Clone)]
pub struct CoreDb {
    conn: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl CoreDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, RuntimeError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| RuntimeError::Internal(format!("create core db dir: {e}")))?;
        }
        let conn = Connection::open(&path)
            .map_err(|e| RuntimeError::Internal(format!("open sqlite: {e}")))?;
        conn.execute_batch(
            "
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS checkpoints (
              session_id TEXT NOT NULL,
              turn_id TEXT NOT NULL,
              seq INTEGER NOT NULL,
              state TEXT NOT NULL,
              iteration INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL,
              PRIMARY KEY (session_id, turn_id)
            );
            CREATE TABLE IF NOT EXISTS hitl_inbox (
              inbox_id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_specs (
              id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_instances (
              key TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
              session_id TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              updated_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cp_state ON checkpoints(state);
            CREATE INDEX IF NOT EXISTS idx_hitl_status ON hitl_inbox(status);
            ",
        )
        .map_err(|e| RuntimeError::Internal(format!("migrate: {e}")))?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            path,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn conn(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.conn)
    }

    pub fn upsert_spec(&self, spec: &AgentSpec) -> Result<(), RuntimeError> {
        let json =
            serde_json::to_string(spec).map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        g.execute(
            "INSERT INTO agent_specs(id, payload_json, updated_at_ms)
             VALUES (?1,?2,?3)
             ON CONFLICT(id) DO UPDATE SET
               payload_json=excluded.payload_json,
               updated_at_ms=excluded.updated_at_ms",
            params![spec.id.as_str(), json, now_ms()],
        )
        .map_err(|e| RuntimeError::Internal(format!("spec save: {e}")))?;
        Ok(())
    }

    pub fn list_specs(&self) -> Result<Vec<AgentSpec>, RuntimeError> {
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        let mut stmt = g
            .prepare("SELECT payload_json FROM agent_specs")
            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            let json = r.map_err(|e| RuntimeError::Internal(e.to_string()))?;
            out.push(
                serde_json::from_str(&json).map_err(|e| RuntimeError::Internal(e.to_string()))?,
            );
        }
        Ok(out)
    }

    pub fn upsert_instance(&self, key: &str, inst: &AgentInstance) -> Result<(), RuntimeError> {
        let json =
            serde_json::to_string(inst).map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        g.execute(
            "INSERT INTO agent_instances(key, payload_json, updated_at_ms)
             VALUES (?1,?2,?3)
             ON CONFLICT(key) DO UPDATE SET
               payload_json=excluded.payload_json,
               updated_at_ms=excluded.updated_at_ms",
            params![key, json, now_ms()],
        )
        .map_err(|e| RuntimeError::Internal(format!("instance save: {e}")))?;
        Ok(())
    }

    pub fn list_instances(&self) -> Result<Vec<(String, AgentInstance)>, RuntimeError> {
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        let mut stmt = g
            .prepare("SELECT key, payload_json FROM agent_instances")
            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            let (key, json) = r.map_err(|e| RuntimeError::Internal(e.to_string()))?;
            let inst: AgentInstance =
                serde_json::from_str(&json).map_err(|e| RuntimeError::Internal(e.to_string()))?;
            out.push((key, inst));
        }
        Ok(out)
    }

    pub fn upsert_session(&self, rec: &SessionRecord) -> Result<(), RuntimeError> {
        let json = serde_json::to_string(rec).map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        g.execute(
            "INSERT INTO sessions(session_id, payload_json, updated_at_ms)
             VALUES (?1,?2,?3)
             ON CONFLICT(session_id) DO UPDATE SET
               payload_json=excluded.payload_json,
               updated_at_ms=excluded.updated_at_ms",
            params![rec.view.session_id.as_str(), json, now_ms()],
        )
        .map_err(|e| RuntimeError::Internal(format!("session save: {e}")))?;
        Ok(())
    }

    pub fn get_session(&self, id: &SessionId) -> Result<Option<SessionRecord>, RuntimeError> {
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        let json: Option<String> = g
            .query_row(
                "SELECT payload_json FROM sessions WHERE session_id=?1",
                params![id.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| RuntimeError::Internal(format!("session get: {e}")))?;
        match json {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).map_err(|e| RuntimeError::Internal(e.to_string()))?,
            )),
            None => Ok(None),
        }
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionRecord>, RuntimeError> {
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        let mut stmt = g
            .prepare("SELECT payload_json FROM sessions")
            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            let json = r.map_err(|e| RuntimeError::Internal(e.to_string()))?;
            out.push(
                serde_json::from_str(&json).map_err(|e| RuntimeError::Internal(e.to_string()))?,
            );
        }
        Ok(out)
    }

    pub fn save_hitl(&self, item: &HitlInboxItem) -> Result<(), RuntimeError> {
        let json =
            serde_json::to_string(item).map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let status = status_str(item.status);
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        g.execute(
            "INSERT INTO hitl_inbox(inbox_id, status, payload_json, updated_at_ms)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(inbox_id) DO UPDATE SET
               status=excluded.status,
               payload_json=excluded.payload_json,
               updated_at_ms=excluded.updated_at_ms",
            params![item.inbox_id.as_str(), status, json, item.created_at_ms],
        )
        .map_err(|e| RuntimeError::Internal(format!("hitl save: {e}")))?;
        Ok(())
    }

    pub fn list_hitl(&self, pending_only: bool) -> Result<Vec<HitlInboxItem>, RuntimeError> {
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        let sql = if pending_only {
            "SELECT payload_json FROM hitl_inbox WHERE status='pending'"
        } else {
            "SELECT payload_json FROM hitl_inbox"
        };
        let mut stmt = g
            .prepare(sql)
            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            let json = r.map_err(|e| RuntimeError::Internal(e.to_string()))?;
            out.push(
                serde_json::from_str(&json).map_err(|e| RuntimeError::Internal(e.to_string()))?,
            );
        }
        Ok(out)
    }

    pub fn get_hitl(&self, inbox_id: &str) -> Result<Option<HitlInboxItem>, RuntimeError> {
        let g = self
            .conn
            .lock()
            .map_err(|_| RuntimeError::Internal("core db lock".into()))?;
        let json: Option<String> = g
            .query_row(
                "SELECT payload_json FROM hitl_inbox WHERE inbox_id=?1",
                params![inbox_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| RuntimeError::Internal(format!("hitl get: {e}")))?;
        match json {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).map_err(|e| RuntimeError::Internal(e.to_string()))?,
            )),
            None => Ok(None),
        }
    }

    pub fn update_hitl(&self, item: &HitlInboxItem) -> Result<(), RuntimeError> {
        self.save_hitl(item)
    }
}

fn status_str(status: HitlInboxStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "pending".into())
}

/// Default Core DB path when `QUBIT_CORE_DB` is unset.
pub fn default_core_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("QUBIT_CORE_DB") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Ok(p) = std::env::var("QUBIT_CHECKPOINT_PATH") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    dirs_fallback()
}

fn dirs_fallback() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home)
        .join(".qubit")
        .join("core")
        .join("runtime.sqlite")
}
