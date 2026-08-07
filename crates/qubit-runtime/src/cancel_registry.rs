//! Per-turn cancel token + abort-handle registry.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;
use tokio::task::AbortHandle;

use qubit_protocol::TurnId;

use crate::cancel::CancelToken;

struct Entry {
    token: CancelToken,
    abort: Option<AbortHandle>,
}

#[derive(Default, Clone)]
pub struct TurnCancelRegistry {
    inner: Arc<RwLock<HashMap<String, Entry>>>,
}

impl TurnCancelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert(&self, turn_id: &TurnId, token: CancelToken) {
        self.inner.write().await.insert(
            turn_id.as_str().to_string(),
            Entry {
                token,
                abort: None,
            },
        );
    }

    pub async fn set_abort(&self, turn_id: &TurnId, abort: AbortHandle) {
        if let Some(e) = self.inner.write().await.get_mut(turn_id.as_str()) {
            e.abort = Some(abort);
        }
    }

    pub async fn cancel(&self, turn_id: &TurnId) -> bool {
        let g = self.inner.read().await;
        if let Some(e) = g.get(turn_id.as_str()) {
            // Cooperative cancel only — hard abort races ahead of TurnCompleted(Cancelled)
            // emission and leaves pollers hanging (see happy_path::cancel_inflight_turn).
            e.token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn remove(&self, turn_id: &TurnId) {
        self.inner.write().await.remove(turn_id.as_str());
    }

    pub async fn len(&self) -> usize {
        self.inner.read().await.len()
    }

    pub async fn contains(&self, turn_id: &TurnId) -> bool {
        self.inner.read().await.contains_key(turn_id.as_str())
    }
}
