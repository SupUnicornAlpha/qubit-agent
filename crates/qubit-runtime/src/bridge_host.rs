//! L2 Legacy Bun bridge as a ToolHost (01 §11).
//!
//! Includes Bun MCP surface advertised as `mcp:<server>:<tool>`
//! (`call_mcp` remains invokable for back-compat but is not advertised).

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
        // Per-call timeout: keep below Bun `QUBIT_PRIME_TURN_TIMEOUT_MS` so one hung
        // MCP cannot pin the turn in Acting until the outer await times out.
        let per_call = std::time::Duration::from_secs(
            std::env::var("QUBIT_LEGACY_BRIDGE_TIMEOUT_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(120)
                .min(90),
        );
        for c in calls {
            cancel.check()?;
            let call_id = c.call_id.clone();
            let name = c.name.clone();
            let invoke = self.client.invoke(LegacyInvokeParams {
                call_id: call_id.clone(),
                name: name.clone(),
                args: c.args,
                idempotency_key: Some(format!("{}:{}", call_id, name)),
                workspace_id: ctx.workspace_id.clone(),
                session_id: ctx.session_id.clone(),
            });
            let timed = tokio::time::timeout(per_call, invoke);
            let result = tokio::select! {
                _ = cancel.cancelled() => {
                    out.push(ToolResult {
                        call_id: ToolCallId::new(call_id),
                        ok: false,
                        observation: Some(serde_json::json!({
                            "ok": false,
                            "error": "turn cancelled while waiting for bridge tool",
                            "error_code": "bridge_invoke_cancelled",
                        })),
                        effects: vec![],
                        retryable: false,
                        error_code: Some("bridge_invoke_cancelled".into()),
                    });
                    // Surface cancellation to the engine loop.
                    return Err(RuntimeError::Cancelled);
                }
                timed_out = timed => match timed_out {
                    Ok(Ok(result)) => result,
                    Ok(Err(e)) => {
                        warn!(tool = %name, error = %e, "legacy bridge invoke failed (soft)");
                        out.push(ToolResult {
                            call_id: ToolCallId::new(call_id),
                            ok: false,
                            observation: Some(serde_json::json!({
                                "ok": false,
                                "error": e.to_string(),
                                "error_code": "bridge_invoke_failed",
                            })),
                            effects: vec![],
                            retryable: true,
                            error_code: Some("bridge_invoke_failed".into()),
                        });
                        continue;
                    }
                    Err(_) => {
                        warn!(tool = %name, secs = per_call.as_secs(), "legacy bridge invoke timed out (soft)");
                        out.push(ToolResult {
                            call_id: ToolCallId::new(call_id),
                            ok: false,
                            observation: Some(serde_json::json!({
                                "ok": false,
                                "error": format!("bridge tool timeout after {}s", per_call.as_secs()),
                                "error_code": "bridge_invoke_timeout",
                            })),
                            effects: vec![],
                            retryable: true,
                            error_code: Some("bridge_invoke_timeout".into()),
                        });
                        continue;
                    }
                }
            };
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
        // Preserve original call order when merging L0 / bridge / fallback buckets.
        let mut tags: Vec<u8> = Vec::with_capacity(calls.len());
        let mut l0_calls = Vec::new();
        let mut bridge_calls = Vec::new();
        let mut other = Vec::new();

        for c in calls {
            let name = c.name.strip_prefix("tool/").unwrap_or(&c.name).to_string();
            if self.l0_names.iter().any(|n| n == &name) {
                tags.push(0);
                l0_calls.push(c);
            } else if self
                .bridge
                .as_ref()
                .map(|b| b.owns_name(&name))
                .unwrap_or(false)
            {
                tags.push(1);
                let mut bridged = c;
                bridged.name = name;
                bridge_calls.push(bridged);
            } else {
                tags.push(2);
                other.push(c);
            }
        }

        let l0_out = if l0_calls.is_empty() {
            Vec::new()
        } else {
            self.l0.invoke_all(l0_calls, cancel.child()).await?
        };
        let bridge_out = if bridge_calls.is_empty() {
            Vec::new()
        } else if let Some(ref b) = self.bridge {
            b.invoke_all(bridge_calls, cancel.child()).await?
        } else {
            self.fallback
                .invoke_all(bridge_calls, cancel.child())
                .await?
        };
        let other_out = if other.is_empty() {
            Vec::new()
        } else {
            self.fallback.invoke_all(other, cancel.child()).await?
        };

        let mut l0_iter = l0_out.into_iter();
        let mut bridge_iter = bridge_out.into_iter();
        let mut other_iter = other_out.into_iter();
        let mut out = Vec::with_capacity(tags.len());
        for tag in tags {
            let next = match tag {
                0 => l0_iter.next(),
                1 => bridge_iter.next(),
                _ => other_iter.next(),
            };
            if let Some(r) = next {
                out.push(r);
            }
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
