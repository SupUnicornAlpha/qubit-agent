use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tokio::sync::{broadcast, RwLock};

use qubit_protocol::RuntimeEvent;

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<RuntimeEvent>,
    seq: Arc<RwLock<u64>>,
    dropped: Arc<AtomicU64>,
    capacity: usize,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let capacity = capacity.max(16);
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            seq: Arc::new(RwLock::new(0)),
            dropped: Arc::new(AtomicU64::new(0)),
            capacity,
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    pub async fn next_seq(&self) -> u64 {
        let mut g = self.seq.write().await;
        *g += 1;
        *g
    }

    pub async fn emit(&self, event: RuntimeEvent) {
        let _ = self.tx.send(event);
    }

    /// Emit with lag awareness for health metrics.
    pub async fn emit_counted(&self, event: RuntimeEvent) {
        let receivers = self.tx.receiver_count();
        match self.tx.send(event) {
            Ok(n) => {
                if receivers > 0 && n < receivers {
                    self.dropped
                        .fetch_add((receivers - n) as u64, Ordering::Relaxed);
                }
            }
            Err(_) => {}
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.tx.subscribe()
    }
}
