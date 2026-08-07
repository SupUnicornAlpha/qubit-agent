//! Tool host adapters for Prime (01 §8 / §11).
//!
//! L0 stays in `qubit-runtime`. This crate owns L2 Legacy Bun bridge (and later MCP).

pub mod error;
pub mod legacy;

pub use error::ToolHostError;
pub use legacy::{
    is_default_bridged_tool_name, LegacyBridgeClient, LegacyBridgeConfig, LegacyInvokeParams,
    LegacyInvokeResult, LegacyToolSpec, DEFAULT_BRIDGED_TOOLS,
};
