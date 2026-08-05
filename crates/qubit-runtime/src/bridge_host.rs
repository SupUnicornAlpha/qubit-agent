//! L2 Legacy Bun bridge as a ToolHost (01 §11).
//!
//! Includes Bun MCP surface advertised as `call_mcp` / `mcp:<server>:<tool>`
//! (strangler: L1 MCP eventually moves into qubit-tool-host; today Bun dispatches).

use std::sync::Arc;

use async_trait::async_trait;
use qubit_protocol::{EffectKind, EffectRecord, SessionId, ToolCallId, ToolResult};
use qubit_tool_host::{
    LegacyBridgeClient, LegacyInvokeParams, LegacyToolSpec, DEFAULT_BRIDGED_TOOLS,
};
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::cancel::CancelToken;
use crate::error::RuntimeError;
use crate::model::NormalizedToolCall;
use crate::tools::ToolHost;

#[derive(Clone, Default)]
struct BridgeTurnContext {
    workspace_id: Option<String>,
    session_id: Option<String>,
}

pub struct BridgeToolHost {
    client: Arc<LegacyBridgeClient>,
    /// Cached names from list, or default allowlist if list fails.
    names: Arc<RwLock<Vec<String>>>,
    turn_ctx: Arc<RwLock<BridgeTurnContext>>,
}

fn is_mcp_bridge_name(name: &str) -> bool {
    name == "call_mcp" || name.starts_with("mcp:")
}

impl BridgeToolHost {
    pub fn new(client: LegacyBridgeClient) -> Self {
        Self::from_shared(Arc::new(client))
    }

    pub fn from_shared(client: Arc<LegacyBridgeClient>) -> Self {
        Self {
            client,
            names: Arc::new(RwLock::new(
                DEFAULT_BRIDGED_TOOLS
                    .iter()
                    .map(|s| (*s).to_string())
                    .collect(),
            )),
            turn_ctx: Arc::new(RwLock::new(BridgeTurnContext::default())),
        }
    }

    pub fn client(&self) -> Arc<LegacyBridgeClient> {
        Arc::clone(&self.client)
    }

    pub async fn refresh_tool_names(&self) -> Result<Vec<LegacyToolSpec>, RuntimeError> {
        match self.client.list_tools().await {
            Ok(specs) => {
                let names: Vec<String> = specs.iter().map(|s| s.name.clone()).collect();
                if !names.is_empty() {
                    *self.names.write().await = names;
                }
                Ok(specs)
            }
            Err(e) => {
                warn!(error = %e, "legacy.tools.list failed; keeping default allowlist");
                Err(RuntimeError::Tool(e.to_string()))
            }
        }
    }

    fn map_effect_kind(raw: &str) -> EffectKind {
        match raw {
            "row_upsert" => EffectKind::RowUpsert,
            "file_write" => EffectKind::FileWrite,
            "artifact" => EffectKind::Artifact,
            _ => EffectKind::Other,
        }
    }

    pub fn owns_name(&self, name: &str) -> bool {
        if is_mcp_bridge_name(name) {
            return true;
        }
        self.names
            .try_read()
            .map(|g| g.iter().any(|n| n == name))
            .unwrap_or_else(|_| DEFAULT_BRIDGED_TOOLS.iter().any(|n| *n == name))
    }
}

#[async_trait]
impl ToolHost for BridgeToolHost {
    async fn bind_turn_context(&self, workspace_id: &str, session_id: &SessionId) {
        {
            let mut g = self.turn_ctx.write().await;
            g.workspace_id = Some(workspace_id.to_string());
            g.session_id = Some(session_id.as_str().to_string());
        }
        // Refresh L2 + MCP names each turn so Core advertises Bun MCP tools.
        match self.refresh_tool_names().await {
            Ok(specs) => {
                let mcp_n = specs.iter().filter(|s| is_mcp_bridge_name(&s.name)).count();
                if mcp_n > 0 {
                    info!(
                        mcp_tools = mcp_n,
                        total = specs.len(),
                        "legacy bridge tool list refreshed"
                    );
                }
            }
            Err(_) => {}
        }
    }

    async fn invoke_all(
        &self,
        calls: Vec<NormalizedToolCall>,
        cancel: CancelToken,
    ) -> Result<Vec<ToolResult>, RuntimeError> {
        cancel.check()?;
        let ctx = self.turn_ctx.read().await.clone();
        let mut out = Vec::with_capacity(calls.len());
        for c in calls {
            cancel.check()?;
            let result = self
                .client
                .invoke(LegacyInvokeParams {
                    call_id: c.call_id.clone(),
                    name: c.name.clone(),
                    args: c.args,
                    idempotency_key: Some(format!("{}:{}", c.call_id, c.name)),
                    workspace_id: ctx.workspace_id.clone(),
                    session_id: ctx.session_id.clone(),
                })
                .await
                .map_err(|e| RuntimeError::Tool(e.to_string()))?;
            out.push(ToolResult {
                call_id: ToolCallId::new(result.call_id),
                ok: result.ok,
                observation: result.observation,
                effects: result
                    .effects
                    .into_iter()
                    .map(|e| EffectRecord {
                        kind: Self::map_effect_kind(&e.kind),
                        key: e.key,
                        meta: e.meta,
                    })
                    .collect(),
                retryable: result.retryable,
                error_code: result.error_code,
            });
        }
        Ok(out)
    }

    fn tool_names(&self) -> Vec<String> {
        // sync snapshot — refresh_tool_names updates async
        self.names
            .try_read()
            .map(|g| g.clone())
            .unwrap_or_else(|_| {
                DEFAULT_BRIDGED_TOOLS
                    .iter()
                    .map(|s| (*s).to_string())
                    .collect()
            })
    }
}

/// Routes L0 tools locally and everything else to the bridge (or fallback).
pub struct CompositeToolHost {
    l0_names: Vec<String>,
    l0: Arc<dyn ToolHost>,
    bridge: Option<Arc<BridgeToolHost>>,
    fallback: Arc<dyn ToolHost>,
}

impl CompositeToolHost {
    pub fn new(
        l0: Arc<dyn ToolHost>,
        bridge: Option<Arc<BridgeToolHost>>,
        fallback: Arc<dyn ToolHost>,
    ) -> Self {
        Self {
            l0_names: vec!["update_plan".into(), "agent.invoke".into()],
            l0,
            bridge,
            fallback,
        }
    }
}

#[async_trait]
impl ToolHost for CompositeToolHost {
    async fn bind_turn_context(&self, workspace_id: &str, session_id: &SessionId) {
        if let Some(ref b) = self.bridge {
            b.bind_turn_context(workspace_id, session_id).await;
        }
        self.l0.bind_turn_context(workspace_id, session_id).await;
        self.fallback
            .bind_turn_context(workspace_id, session_id)
            .await;
    }

    async fn invoke_all(
        &self,
        calls: Vec<NormalizedToolCall>,
        cancel: CancelToken,
    ) -> Result<Vec<ToolResult>, RuntimeError> {
        cancel.check()?;
        let mut l0_calls = Vec::new();
        let mut bridge_calls = Vec::new();
        let mut other = Vec::new();

        for c in calls {
            let name = c.name.strip_prefix("tool/").unwrap_or(&c.name).to_string();
            if self.l0_names.iter().any(|n| n == &name) {
                l0_calls.push(c);
            } else if self
                .bridge
                .as_ref()
                .map(|b| b.owns_name(&name))
                .unwrap_or(false)
            {
                // Normalize tool/ prefix away for Bun bridge wire names.
                let mut bridged = c;
                bridged.name = name;
                bridge_calls.push(bridged);
            } else {
                other.push(c);
            }
        }

        let mut out = Vec::new();
        if !l0_calls.is_empty() {
            out.extend(self.l0.invoke_all(l0_calls, cancel.child()).await?);
        }
        if !bridge_calls.is_empty() {
            if let Some(ref b) = self.bridge {
                out.extend(b.invoke_all(bridge_calls, cancel.child()).await?);
            } else {
                out.extend(
                    self.fallback
                        .invoke_all(bridge_calls, cancel.child())
                        .await?,
                );
            }
        }
        if !other.is_empty() {
            out.extend(self.fallback.invoke_all(other, cancel.child()).await?);
        }
        Ok(out)
    }

    fn tool_names(&self) -> Vec<String> {
        let mut names = self.l0_names.clone();
        if let Some(ref b) = self.bridge {
            for n in b.tool_names() {
                if !names.contains(&n) {
                    names.push(n);
                }
            }
        }
        for n in self.fallback.tool_names() {
            if !names.contains(&n) {
                names.push(n);
            }
        }
        names
    }
}
