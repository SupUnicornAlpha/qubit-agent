use async_trait::async_trait;
use qubit_protocol::{
    AgentPlanSnapshot, AgentSpecId, EffectKind, EffectRecord, InvocationBudget, InvocationId,
    InvocationRequest, ProtocolError, SessionId, ToolCallId, ToolResult, TurnId,
};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::cancel::CancelToken;
use crate::error::RuntimeError;
use crate::invocation::AgentInvoker;
use crate::model::NormalizedToolCall;
use crate::store::SharedStore;

#[async_trait]
pub trait ToolHost: Send + Sync {
    async fn invoke_all(
        &self,
        calls: Vec<NormalizedToolCall>,
        cancel: CancelToken,
    ) -> Result<Vec<ToolResult>, RuntimeError>;

    /// Tool names advertised to the model for this turn.
    fn tool_names(&self) -> Vec<String> {
        vec![]
    }

    /// Bind workspace/session so bridge invokes can correlate Bun UI streams.
    async fn bind_turn_context(&self, _workspace_id: &str, _session_id: &SessionId) {}
}

#[derive(Debug, Default)]
pub struct FakeToolHost;

#[async_trait]
impl ToolHost for FakeToolHost {
    async fn invoke_all(
        &self,
        calls: Vec<NormalizedToolCall>,
        cancel: CancelToken,
    ) -> Result<Vec<ToolResult>, RuntimeError> {
        cancel.check()?;
        let mut out = Vec::with_capacity(calls.len());
        for c in calls {
            out.push(ToolResult {
                call_id: ToolCallId::new(c.call_id),
                ok: true,
                observation: Some(json!({ "summary": format!("fake ok: {}", c.name) })),
                effects: vec![EffectRecord {
                    kind: EffectKind::Other,
                    key: c.name,
                    meta: None,
                }],
                retryable: false,
                error_code: None,
            });
        }
        Ok(out)
    }

    fn tool_names(&self) -> Vec<String> {
        vec!["update_plan".into(), "agent.invoke".into()]
    }
}

/// L0 meta tools hosted in Core: `update_plan`, `agent.invoke`.
pub struct L0ToolHost {
    store: SharedStore,
    /// Current session for plan writes / invoke parent binding.
    session_id: Arc<RwLock<Option<SessionId>>>,
    invoker: std::sync::RwLock<Option<Arc<dyn AgentInvoker>>>,
    fallback: Arc<dyn ToolHost>,
}

impl L0ToolHost {
    pub fn new(store: SharedStore, fallback: Arc<dyn ToolHost>) -> Self {
        Self {
            store,
            session_id: Arc::new(RwLock::new(None)),
            invoker: std::sync::RwLock::new(None),
            fallback,
        }
    }

    pub async fn bind_session(&self, session_id: SessionId) {
        *self.session_id.write().await = Some(session_id);
    }

    /// Wire after `InvocationService` is constructed (breaks build cycle).
    pub fn bind_invoker(&self, invoker: Arc<dyn AgentInvoker>) {
        *self.invoker.write().expect("invoker lock") = Some(invoker);
    }

    async fn handle_update_plan(
        &self,
        call: &NormalizedToolCall,
    ) -> Result<ToolResult, RuntimeError> {
        let plan: AgentPlanSnapshot = serde_json::from_value(call.args.clone()).map_err(|e| {
            ProtocolError::InvalidRequest {
                message: format!("update_plan args: {e}"),
            }
        })?;
        let sid = self.session_id.read().await.clone().ok_or_else(|| {
            RuntimeError::Internal("update_plan: no session bound".into())
        })?;
        self.store.set_plan(&sid, Some(plan.clone())).await?;
        Ok(ToolResult {
            call_id: ToolCallId::new(call.call_id.clone()),
            ok: true,
            observation: Some(json!({
                "summary": format!("plan updated ({} steps)", plan.steps.len()),
                "plan": plan,
            })),
            effects: vec![EffectRecord {
                kind: EffectKind::Artifact,
                key: "agent_plan".into(),
                meta: Some(json!({ "steps": plan.steps.len() })),
            }],
            retryable: false,
            error_code: None,
        })
    }

    async fn handle_agent_invoke(
        &self,
        call: &NormalizedToolCall,
        cancel: CancelToken,
    ) -> Result<ToolResult, RuntimeError> {
        let parent_sid = self.session_id.read().await.clone().ok_or_else(|| {
            RuntimeError::Internal("agent.invoke: no session bound".into())
        })?;
        let invoker = self
            .invoker
            .read()
            .expect("invoker lock")
            .clone()
            .ok_or_else(|| RuntimeError::Internal("agent.invoke: invoker not bound".into()))?;

        let parent = self.store.get_session(&parent_sid).await?;
        let parent_turn_id = parent
            .active_turn
            .as_ref()
            .map(|t| t.turn_id.clone())
            .unwrap_or_else(|| TurnId::new(format!("trn_parent_{}", call.call_id)));

        let callee_raw = call
            .args
            .get("callee_spec_id")
            .or_else(|| call.args.get("agent_ref"))
            .or_else(|| call.args.get("spec_id"))
            .or_else(|| call.args.get("agent_id"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ProtocolError::InvalidRequest {
                message: "agent.invoke requires callee_spec_id (or agent_ref/spec_id)".into(),
            })?;
        let goal = call
            .args
            .get("goal")
            .or_else(|| call.args.get("task"))
            .or_else(|| call.args.get("prompt"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ProtocolError::InvalidRequest {
                message: "agent.invoke requires goal (or task/prompt)".into(),
            })?;
        let max_iterations = call
            .args
            .get("max_iterations")
            .and_then(|v| v.as_u64())
            .or_else(|| {
                call.args
                    .get("budget")
                    .and_then(|b| b.get("max_iterations"))
                    .and_then(|v| v.as_u64())
            })
            .unwrap_or(8)
            .clamp(1, 64) as u32;

        let invocation_id = call
            .args
            .get("invocation_id")
            .and_then(|v| v.as_str())
            .map(|s| InvocationId::new(s))
            .unwrap_or_else(|| InvocationId::new(format!("inv_{}", call.call_id)));

        let req = InvocationRequest {
            invocation_id: invocation_id.clone(),
            parent_session_id: parent_sid.clone(),
            parent_turn_id,
            caller_instance_id: parent.view.agent_instance_id.clone(),
            callee_spec_id: AgentSpecId::new(callee_raw),
            goal: goal.to_string(),
            handoff_in: None,
            deadline_ms: None,
            budget: InvocationBudget {
                max_iterations,
                max_tokens: None,
                tool_surface_override: None,
            },
        };

        let record = invoker.invoke_agent(req, cancel).await?;

        // Child turn rebinds L0 session; restore parent for subsequent tools.
        self.bind_session(parent_sid).await;

        let ok = matches!(
            record.state,
            qubit_protocol::InvocationState::Completed
        );
        Ok(ToolResult {
            call_id: ToolCallId::new(call.call_id.clone()),
            ok,
            observation: Some(json!({
                "summary": format!(
                    "invoke {} → {} ({})",
                    callee_raw,
                    record.state.as_wire(),
                    record.child_session_id
                ),
                "invocation_id": invocation_id.as_str(),
                "callee_spec_id": callee_raw,
                "child_session_id": record.child_session_id.as_str(),
                "child_turn_id": record.child_turn_id.as_str(),
                "state": record.state.as_wire(),
                "handoff_out": record.handoff_out,
                "delivery": record.delivery,
            })),
            effects: vec![EffectRecord {
                kind: EffectKind::Other,
                key: "agent.invoke".into(),
                meta: Some(json!({
                    "invocation_id": invocation_id.as_str(),
                    "callee_spec_id": callee_raw,
                })),
            }],
            retryable: false,
            error_code: if ok {
                None
            } else {
                Some("invoke_failed".into())
            },
        })
    }
}

#[async_trait]
impl ToolHost for L0ToolHost {
    async fn invoke_all(
        &self,
        calls: Vec<NormalizedToolCall>,
        cancel: CancelToken,
    ) -> Result<Vec<ToolResult>, RuntimeError> {
        cancel.check()?;
        let mut out = Vec::new();
        let mut rest = Vec::new();
        for c in calls {
            let name = c.name.strip_prefix("tool/").unwrap_or(&c.name);
            if name == "update_plan" {
                out.push(self.handle_update_plan(&c).await?);
            } else if name == "agent.invoke" {
                out.push(self.handle_agent_invoke(&c, cancel.child()).await?);
            } else {
                rest.push(c);
            }
        }
        if !rest.is_empty() {
            out.extend(self.fallback.invoke_all(rest, cancel).await?);
        }
        Ok(out)
    }

    fn tool_names(&self) -> Vec<String> {
        let mut names = self.fallback.tool_names();
        for l0 in ["update_plan", "agent.invoke"] {
            if !names.iter().any(|n| n == l0) {
                names.insert(0, l0.into());
            }
        }
        names
    }
}
