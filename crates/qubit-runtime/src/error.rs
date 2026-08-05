use thiserror::Error;

use qubit_protocol::ProtocolError;

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("cancelled")]
    Cancelled,
    #[error("model error: {0}")]
    Model(String),
    #[error("tool error: {0}")]
    Tool(String),
    #[error("internal: {0}")]
    Internal(String),
    #[error("saturated: active={active} limit={limit}")]
    Saturated { active: u32, limit: u32 },
}
