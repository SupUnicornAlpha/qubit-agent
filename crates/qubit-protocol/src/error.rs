//! Protocol-level error codes (shared by runtime / app-server).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Debug, Error, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProtocolError {
    #[error("admission denied: {message}")]
    AdmissionDenied { message: String },
    #[error("not found: {resource}")]
    NotFound { resource: String },
    #[error("invalid request: {message}")]
    InvalidRequest { message: String },
    #[error("conflict: {message}")]
    Conflict { message: String },
    #[error("unavailable: {message}")]
    Unavailable { message: String },
}
