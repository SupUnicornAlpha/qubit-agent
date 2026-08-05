//! Concurrent turn supervisor — admit / backpressure (01 M6).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::error::RuntimeError;

#[derive(Clone, Debug)]
pub struct RuntimeLimits {
    /// Max in-flight turns (user + invoke + reactor).
    pub max_concurrent_turns: u32,
    /// Event bus broadcast capacity (lag / drop beyond this).
    pub event_bus_capacity: usize,
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        Self {
            max_concurrent_turns: 32,
            event_bus_capacity: 256,
        }
    }
}

#[derive(Clone)]
pub struct TurnSupervisor {
    sem: Arc<Semaphore>,
    active: Arc<AtomicU32>,
    limits: RuntimeLimits,
}

impl TurnSupervisor {
    pub fn new(limits: RuntimeLimits) -> Self {
        let n = limits.max_concurrent_turns.max(1) as usize;
        Self {
            sem: Arc::new(Semaphore::new(n)),
            active: Arc::new(AtomicU32::new(0)),
            limits,
        }
    }

    pub fn limits(&self) -> &RuntimeLimits {
        &self.limits
    }

    pub fn active_turns(&self) -> u32 {
        self.active.load(Ordering::SeqCst)
    }

    /// Non-blocking admit. Err when saturated → client should back off.
    pub fn try_acquire(&self) -> Result<TurnPermit, RuntimeError> {
        match self.sem.clone().try_acquire_owned() {
            Ok(permit) => {
                self.active.fetch_add(1, Ordering::SeqCst);
                Ok(TurnPermit {
                    _permit: permit,
                    active: Arc::clone(&self.active),
                })
            }
            Err(_) => Err(RuntimeError::Saturated {
                active: self.active_turns(),
                limit: self.limits.max_concurrent_turns,
            }),
        }
    }
}

pub struct TurnPermit {
    _permit: OwnedSemaphorePermit,
    active: Arc<AtomicU32>,
}

impl Drop for TurnPermit {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}
