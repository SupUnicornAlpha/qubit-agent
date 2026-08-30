//! Tool host adapters for Prime (01 §8 / §11).
//!
//! L0 stays in `qubit-runtime`. This crate owns L2 Legacy Bun bridge (and later MCP).

pub mod error;
pub mod legacy;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Provider-neutral tool definition owned by the tool registry/host.
/// Core only filters and forwards these definitions; it never describes
/// business tools or manufactures their schemas.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_parameters")]
    pub parameters: Value,
}

fn default_parameters() -> Value {
    json!({
        "type": "object",
        "additionalProperties": true
    })
}

impl ToolDefinition {
    pub fn generic(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: String::new(),
            parameters: default_parameters(),
        }
    }
}

pub use error::ToolHostError;
pub use legacy::{
    is_default_bridged_tool_name, LegacyBridgeClient, LegacyBridgeConfig, LegacyInvokeParams,
    LegacyInvokeResult, LegacyToolSpec, DEFAULT_BRIDGED_TOOLS,
};
