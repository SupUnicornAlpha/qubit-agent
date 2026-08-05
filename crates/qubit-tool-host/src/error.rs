use thiserror::Error;

#[derive(Debug, Error)]
pub enum ToolHostError {
    #[error("bridge HTTP error: {0}")]
    Http(String),
    #[error("bridge RPC error: {0}")]
    Rpc(String),
    #[error("bridge unavailable: {0}")]
    Unavailable(String),
    #[error("invalid response: {0}")]
    Invalid(String),
}
