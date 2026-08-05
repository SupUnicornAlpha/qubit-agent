//! WorkspaceContextPort via Legacy Bun bridge — FS rules / QUBIT.md (OUT of Core).

use std::sync::Arc;

use async_trait::async_trait;
use qubit_tool_host::{LegacyBridgeClient, LegacyInvokeParams};
use serde_json::json;
use uuid::Uuid;

use crate::error::RuntimeError;

use super::ports::{WorkspaceContextPort, WorkspaceContextSlice, WorkspaceFocus};

pub struct BridgeWorkspacePort {
    client: Arc<LegacyBridgeClient>,
}

impl BridgeWorkspacePort {
    pub fn new(client: Arc<LegacyBridgeClient>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl WorkspaceContextPort for BridgeWorkspacePort {
    async fn snapshot(
        &self,
        workspace_id: &str,
        focus: &WorkspaceFocus,
    ) -> Result<WorkspaceContextSlice, RuntimeError> {
        // Core session workspace_id may be wf_* — Bun resolves via loopOptions / env.
        let result = self
            .client
            .invoke(LegacyInvokeParams {
                call_id: format!("wsctx_{}", Uuid::new_v4().simple()),
                name: "workspace.context.snapshot".into(),
                args: json!({
                    "workspace_id": workspace_id,
                    "fs_workspace_id": if workspace_id.starts_with("wf_") {
                        serde_json::Value::Null
                    } else {
                        serde_json::Value::String(workspace_id.to_string())
                    },
                    "open_files": focus.open_files,
                    "focus_symbols": focus.focus_symbols,
                }),
                idempotency_key: None,
                workspace_id: Some(workspace_id.to_string()),
                session_id: None,
            })
            .await
            .map_err(|e| RuntimeError::Internal(format!("bridge workspace: {e}")))?;

        if !result.ok {
            tracing::debug!(
                error = ?result.error_code,
                "workspace.context.snapshot failed; using focus-only slice"
            );
            return Ok(fallback_slice(workspace_id, focus));
        }

        let text = result
            .observation
            .as_ref()
            .and_then(|o| o.get("context_block"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| fallback_slice(workspace_id, focus).text);

        Ok(WorkspaceContextSlice { text })
    }
}

fn fallback_slice(workspace_id: &str, focus: &WorkspaceFocus) -> WorkspaceContextSlice {
    let mut parts = vec![format!("workspace: {workspace_id}")];
    if !focus.open_files.is_empty() {
        parts.push(format!("open: {}", focus.open_files.join(", ")));
    }
    if !focus.focus_symbols.is_empty() {
        parts.push(format!("symbols: {}", focus.focus_symbols.join(", ")));
    }
    if let Some(ref c) = focus.convention_text {
        if !c.trim().is_empty() {
            parts.push(c.clone());
        }
    }
    WorkspaceContextSlice {
        text: parts.join("\n"),
    }
}
