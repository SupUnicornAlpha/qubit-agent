use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::RwLock;

use qubit_protocol::{
    HitlInboxFilter, HitlInboxItem, HitlInboxStatus, HitlResponse, ProtocolError,
};

use crate::core_db::CoreDb;
use crate::error::RuntimeError;

#[async_trait]
pub trait HitlInbox: Send + Sync {
    async fn enqueue(&self, item: HitlInboxItem) -> Result<(), RuntimeError>;
    async fn list_pending(&self, filter: HitlInboxFilter) -> Result<Vec<HitlInboxItem>, RuntimeError>;
    async fn respond(&self, response: HitlResponse) -> Result<HitlInboxItem, RuntimeError>;
}

#[derive(Default, Clone)]
pub struct MemoryHitlInbox {
    items: Arc<RwLock<Vec<HitlInboxItem>>>,
}

impl MemoryHitlInbox {
    pub fn new() -> Self {
        Self::default()
    }
}

fn matches_filter(item: &HitlInboxItem, filter: &HitlInboxFilter) -> bool {
    if filter.pending_only && item.status != HitlInboxStatus::Pending {
        return false;
    }
    if let Some(ref ws) = filter.workspace_id {
        if &item.workspace_id != ws {
            return false;
        }
    }
    if let Some(ref sid) = filter.session_id {
        if &item.session_id != sid {
            return false;
        }
    }
    true
}

#[async_trait]
impl HitlInbox for MemoryHitlInbox {
    async fn enqueue(&self, item: HitlInboxItem) -> Result<(), RuntimeError> {
        self.items.write().await.push(item);
        Ok(())
    }

    async fn list_pending(&self, filter: HitlInboxFilter) -> Result<Vec<HitlInboxItem>, RuntimeError> {
        let items = self.items.read().await;
        Ok(items
            .iter()
            .filter(|i| matches_filter(i, &filter))
            .cloned()
            .collect())
    }

    async fn respond(&self, response: HitlResponse) -> Result<HitlInboxItem, RuntimeError> {
        let mut items = self.items.write().await;
        let item = items
            .iter_mut()
            .find(|i| i.inbox_id == response.inbox_id)
            .ok_or_else(|| ProtocolError::NotFound {
                resource: format!("inbox {}", response.inbox_id),
            })?;
        if item.status != HitlInboxStatus::Pending {
            return Err(ProtocolError::Conflict {
                message: "inbox item not pending".into(),
            }
            .into());
        }
        item.status = if response.approved {
            HitlInboxStatus::Approved
        } else {
            HitlInboxStatus::Rejected
        };
        Ok(item.clone())
    }
}

/// Durable HITL inbox backed by Core SQLite (same DB as sessions / checkpoints).
pub struct SqliteHitlInbox {
    db: Arc<CoreDb>,
}

impl SqliteHitlInbox {
    pub fn new(db: Arc<CoreDb>) -> Self {
        Self { db }
    }
}

#[async_trait]
impl HitlInbox for SqliteHitlInbox {
    async fn enqueue(&self, item: HitlInboxItem) -> Result<(), RuntimeError> {
        let db = Arc::clone(&self.db);
        tokio::task::spawn_blocking(move || db.save_hitl(&item))
            .await
            .map_err(|e| RuntimeError::Internal(format!("join: {e}")))?
    }

    async fn list_pending(&self, filter: HitlInboxFilter) -> Result<Vec<HitlInboxItem>, RuntimeError> {
        let db = Arc::clone(&self.db);
        let pending_only = filter.pending_only;
        let items = tokio::task::spawn_blocking(move || db.list_hitl(pending_only))
            .await
            .map_err(|e| RuntimeError::Internal(format!("join: {e}")))??;
        Ok(items
            .into_iter()
            .filter(|i| matches_filter(i, &filter))
            .collect())
    }

    async fn respond(&self, response: HitlResponse) -> Result<HitlInboxItem, RuntimeError> {
        let db = Arc::clone(&self.db);
        tokio::task::spawn_blocking(move || {
            let mut item = db
                .get_hitl(response.inbox_id.as_str())?
                .ok_or_else(|| {
                    RuntimeError::from(ProtocolError::NotFound {
                        resource: format!("inbox {}", response.inbox_id),
                    })
                })?;
            if item.status != HitlInboxStatus::Pending {
                return Err(ProtocolError::Conflict {
                    message: "inbox item not pending".into(),
                }
                .into());
            }
            item.status = if response.approved {
                HitlInboxStatus::Approved
            } else {
                HitlInboxStatus::Rejected
            };
            db.update_hitl(&item)?;
            Ok(item)
        })
        .await
        .map_err(|e| RuntimeError::Internal(format!("join: {e}")))?
    }
}
