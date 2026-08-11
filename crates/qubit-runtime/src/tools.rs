use async_trait::async_trait;
use qubit_protocol::{
    AgentGoalSnapshot, AgentPlanSnapshot, AgentPlanStep, AgentSpec, AgentSpecId, EffectKind,
    EffectRecord, GoalStatus, InteractionMode, InvocationBudget, InvocationId, InvocationRequest,
    PlanStepStatus, SessionId, ToolCallId, ToolResult, TurnId,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::cancel::CancelToken;
use crate::error::RuntimeError;
use crate::invocation::AgentInvoker;
use crate::model::NormalizedToolCall;
use crate::store::SharedStore;

/// Lenient parse aligned with Bun `update_plan` handler: LLM often omits step `id`.
/// Missing id → `s{n}`; title falls back to `text`; unknown status → pending.
///
/// Prefer [`parse_update_plan_args_for_session`] when a session interaction mode is known.
pub fn parse_update_plan_args(args: &Value) -> Result<AgentPlanSnapshot, String> {
    parse_update_plan_args_for_session(args, None)
}

/// When `session_mode` is Goal/Agent, ignore args.`mode:"plan"` so progress isn't wiped.
/// Only session Plan (or legacy no-session + args.mode=plan) forces all steps pending.
pub fn parse_update_plan_args_for_session(
    args: &Value,
    session_mode: Option<InteractionMode>,
) -> Result<AgentPlanSnapshot, String> {
    let obj = args
        .as_object()
        .ok_or_else(|| "update_plan args must be an object".to_string())?;

    let args_mode = obj
        .get("mode")
        .and_then(|v| v.as_str())
        .and_then(InteractionMode::parse);

    let force_pending = match session_mode {
        Some(InteractionMode::Plan) => true,
        Some(_) => false,
        None => args_mode == Some(InteractionMode::Plan),
    };
    let mode = session_mode.or(args_mode);

    let mut steps = Vec::new();
    if let Some(arr) = obj.get("steps").and_then(|v| v.as_array()) {
        for (i, raw) in arr.iter().take(20).enumerate() {
            let step = raw.as_object();
            let title = step
                .and_then(|s| {
                    s.get("title")
                        .or_else(|| s.get("text"))
                        .and_then(|v| v.as_str())
                })
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("")
                .chars()
                .take(200)
                .collect::<String>();
            if title.is_empty() {
                continue;
            }
            let id = step
                .and_then(|s| s.get("id").and_then(|v| v.as_str()))
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(40).collect::<String>())
                .unwrap_or_else(|| format!("s{}", i + 1));
            let status_raw = step
                .and_then(|s| s.get("status").and_then(|v| v.as_str()))
                .unwrap_or("pending")
                .trim();
            let status = match status_raw {
                "pending" => PlanStepStatus::Pending,
                "in_progress" | "in-progress" | "running" => PlanStepStatus::InProgress,
                "done" | "completed" | "complete" => PlanStepStatus::Done,
                "skipped" | "skip" => PlanStepStatus::Skipped,
                _ => PlanStepStatus::Pending,
            };
            let status = if force_pending {
                PlanStepStatus::Pending
            } else {
                status
            };
            let note = step
                .and_then(|s| s.get("note"))
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(300).collect::<String>());
            steps.push(AgentPlanStep {
                id,
                title,
                status,
                note,
            });
        }
    }

    let goal = obj.get("goal").and_then(|g| {
        if let Some(text) = g.as_str() {
            let t = text.trim();
            if t.is_empty() {
                return None;
            }
            return Some(AgentGoalSnapshot {
                text: Some(t.chars().take(2000).collect()),
                status: None,
                completed_steps: None,
                total_steps: Some(steps.len() as u32),
                success_criteria: vec![],
                constraints: vec![],
                blocker: None,
            });
        }
        let go = g.as_object()?;
        let text = go
            .get("text")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(2000).collect::<String>());
        let status = go
            .get("status")
            .and_then(|v| v.as_str())
            .and_then(|s| match s {
                "planning" => Some(GoalStatus::Planning),
                "executing" => Some(GoalStatus::Executing),
                "paused" => Some(GoalStatus::Paused),
                "completed" => Some(GoalStatus::Completed),
                "blocked" => Some(GoalStatus::Blocked),
                "cleared" => Some(GoalStatus::Cleared),
                _ => None,
            });
        let list = |key: &str| -> Vec<String> {
            go.get(key)
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str())
                        .map(|s| s.trim().chars().take(300).collect::<String>())
                        .filter(|s| !s.is_empty())
                        .take(10)
                        .collect()
                })
                .unwrap_or_default()
        };
        Some(AgentGoalSnapshot {
            text,
            status,
            completed_steps: go
                .get("completed_steps")
                .or_else(|| go.get("completedSteps"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32),
            total_steps: go
                .get("total_steps")
                .or_else(|| go.get("totalSteps"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
                .or(Some(steps.len() as u32)),
            success_criteria: list("success_criteria")
                .into_iter()
                .chain(list("successCriteria"))
                .collect(),
            constraints: list("constraints"),
            blocker: go
                .get("blocker")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(500).collect()),
        })
    });

    let updated_at = obj
        .get("updated_at")
        .or_else(|| obj.get("updatedAt"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    Ok(AgentPlanSnapshot {
        mode,
        goal,
        steps,
        updated_at,
    })
}

fn tool_err(call_id: &str, message: impl Into<String>) -> ToolResult {
    let message = message.into();
    ToolResult {
        call_id: ToolCallId::new(call_id),
        ok: false,
        observation: Some(json!({ "summary": message, "error": message })),
        effects: vec![],
        retryable: true,
        error_code: Some("invalid_args".into()),
    }
}

fn value_as_nonempty_str(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        Value::Object(o) => ["id", "spec_id", "agent_id", "name", "role", "ref"]
            .iter()
            .find_map(|k| o.get(*k).and_then(value_as_nonempty_str)),
        _ => None,
    }
}

/// Pull callee hint from common LLM field aliases (schema historically only required `goal`).
pub fn extract_agent_invoke_callee_hint(args: &Value) -> Option<String> {
    let obj = args.as_object()?;
    const KEYS: &[&str] = &[
        "callee_spec_id",
        "agent_ref",
        "spec_id",
        "agent_id",
        "agent",
        "role",
        "target",
        "name",
        "specialist",
        "callee",
        "subagent",
        "expert",
        "to",
    ];
    for k in KEYS {
        if let Some(s) = obj.get(*k).and_then(value_as_nonempty_str) {
            return Some(s);
        }
    }
    None
}

pub fn extract_agent_invoke_goal(args: &Value) -> Option<String> {
    let obj = args.as_object()?;
    for k in ["goal", "task", "prompt", "query", "instruction", "message"] {
        if let Some(s) = obj.get(k).and_then(value_as_nonempty_str) {
            return Some(s);
        }
    }
    None
}

fn norm_key(s: &str) -> String {
    s.trim()
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// Resolve LLM alias (id / label / display_name / role slug) to a catalog spec id.
pub fn resolve_callee_spec_id(hint: &str, specs: &[AgentSpec]) -> Option<String> {
    let raw = hint.trim();
    if raw.is_empty() {
        return None;
    }
    let key = norm_key(raw);
    if key.is_empty() {
        // Pure punctuation — fall through to exact display_name compare only.
        for s in specs {
            if s.display_name == raw {
                return Some(s.id.as_str().to_string());
            }
        }
        return None;
    }

    for s in specs {
        if s.id.as_str() == raw || norm_key(s.id.as_str()) == key {
            return Some(s.id.as_str().to_string());
        }
    }

    let stripped = key
        .strip_prefix("def")
        .map(|s| s.trim_start_matches(|c: char| !c.is_alphanumeric()))
        .unwrap_or(key.as_str());
    for s in specs {
        let idn = norm_key(s.id.as_str());
        let id_stripped = idn
            .strip_prefix("def")
            .map(|s| s.trim_start_matches(|c: char| !c.is_alphanumeric()))
            .unwrap_or(idn.as_str());
        if id_stripped == stripped || idn == key || idn == format!("def{stripped}") {
            return Some(s.id.as_str().to_string());
        }
    }

    for s in specs {
        if s.labels
            .iter()
            .any(|l| norm_key(l) == key || l.eq_ignore_ascii_case(raw))
        {
            return Some(s.id.as_str().to_string());
        }
        if norm_key(&s.display_name) == key || s.display_name == raw {
            return Some(s.id.as_str().to_string());
        }
    }

    for s in specs {
        if s.labels.iter().any(|l| {
            let ln = norm_key(l);
            !ln.is_empty() && (ln.contains(&key) || key.contains(&ln))
        }) {
            return Some(s.id.as_str().to_string());
        }
    }
    None
}

/// When callee omitted, lightly infer from goal text (news / market / research).
pub fn infer_callee_from_goal(goal: &str, specs: &[AgentSpec]) -> Option<String> {
    let g = goal.to_lowercase();
    let candidates: &[(&str, &[&str])] = &[
        (
            "def-news-event",
            &["新闻", "news", "headline", "舆情", "sentiment", "互联网"],
        ),
        (
            "def-market-data",
            &["行情", "报价", "k线", "quote", "price", "ohlc", "snapshot"],
        ),
        (
            "def-analyst-sentiment",
            &["舆情分析", "情绪", "sentiment analyst"],
        ),
        (
            "def-research",
            &["因子", "策略", "回测", "factor", "strategy"],
        ),
    ];
    for (spec_id, keys) in candidates {
        if keys.iter().any(|k| g.contains(k)) && specs.iter().any(|s| s.id.as_str() == *spec_id) {
            return Some((*spec_id).to_string());
        }
    }
    None
}

fn format_available_specs(specs: &[AgentSpec]) -> String {
    let mut rows: Vec<String> = specs
        .iter()
        .filter(|s| s.enabled)
        .filter(|s| {
            matches!(
                s.execution_kind,
                qubit_protocol::ExecutionKind::Subagent | qubit_protocol::ExecutionKind::Reactor
            )
        })
        .map(|s| {
            let labels = s.labels.join(",");
            format!(
                "{} ({}; labels=[{}])",
                s.id.as_str(),
                s.display_name,
                labels
            )
        })
        .collect();
    rows.sort();
    if rows.is_empty() {
        "(no subagent/reactor specs loaded)".into()
    } else {
        rows.join("; ")
    }
}

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
        let sid = match self.session_id.read().await.clone() {
            Some(s) => s,
            None => {
                return Ok(tool_err(&call.call_id, "update_plan: no session bound"));
            }
        };
        let session_mode = self
            .store
            .get_session(&sid)
            .await
            .ok()
            .map(|s| s.view.interaction_mode);
        let plan = match parse_update_plan_args_for_session(&call.args, session_mode) {
            Ok(p) => p,
            Err(e) => return Ok(tool_err(&call.call_id, format!("update_plan args: {e}"))),
        };
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
        let parent_sid = match self.session_id.read().await.clone() {
            Some(s) => s,
            None => {
                return Ok(tool_err(&call.call_id, "agent.invoke: no session bound"));
            }
        };
        let invoker = match self.invoker.read().expect("invoker lock").clone() {
            Some(i) => i,
            None => {
                return Ok(tool_err(&call.call_id, "agent.invoke: invoker not bound"));
            }
        };

        let parent = self.store.get_session(&parent_sid).await?;
        let parent_turn_id = parent
            .active_turn
            .as_ref()
            .map(|t| t.turn_id.clone())
            .unwrap_or_else(|| TurnId::new(format!("trn_parent_{}", call.call_id)));

        let specs = self.store.list_specs().await;
        let goal = match extract_agent_invoke_goal(&call.args) {
            Some(g) => g,
            None => {
                return Ok(tool_err(
                    &call.call_id,
                    "agent.invoke requires goal (or task/prompt). Retry with {\"callee_spec_id\":\"def-news-event\",\"goal\":\"...\"}",
                ));
            }
        };

        let callee_hint = extract_agent_invoke_callee_hint(&call.args);
        let callee_raw = match callee_hint.as_deref() {
            Some(hint) => resolve_callee_spec_id(hint, &specs).or_else(|| Some(hint.to_string())),
            None => infer_callee_from_goal(&goal, &specs),
        };

        let callee_raw = match callee_raw {
            Some(id) => id,
            None => {
                let available = format_available_specs(&specs);
                return Ok(tool_err(
                    &call.call_id,
                    format!(
                        "agent.invoke missing callee_spec_id. Pass one of: {available}. Example: {{\"callee_spec_id\":\"def-news-event\",\"goal\":\"...\"}}"
                    ),
                ));
            }
        };

        // If hint didn't resolve to a known spec, still try invoke (admission will fail clearly).
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
            .unwrap_or(5)
            .clamp(1, 32) as u32;

        let invocation_id = call
            .args
            .get("invocation_id")
            .and_then(|v| v.as_str())
            .map(InvocationId::new)
            .unwrap_or_else(|| InvocationId::new(format!("inv_{}", call.call_id)));

        // Nested child turns eat the parent's wall-clock. Cap so parent can still
        // synthesize after market+news (QUBIT_PRIME_TURN_TIMEOUT_MS ≈ 300s).
        let deadline_ms = call
            .args
            .get("deadline_ms")
            .and_then(|v| v.as_i64())
            .filter(|n| *n > 0)
            .unwrap_or_else(|| {
                let id = callee_raw.to_ascii_lowercase();
                if id.contains("news") {
                    120_000
                } else if id.contains("market") {
                    120_000
                } else {
                    120_000
                }
            })
            .clamp(15_000, 180_000);

        let req = InvocationRequest {
            invocation_id: invocation_id.clone(),
            parent_session_id: parent_sid.clone(),
            parent_turn_id,
            caller_instance_id: parent.view.agent_instance_id.clone(),
            callee_spec_id: AgentSpecId::new(callee_raw.clone()),
            goal: goal.clone(),
            handoff_in: None,
            deadline_ms: Some(deadline_ms),
            budget: InvocationBudget {
                max_iterations,
                max_tokens: None,
                tool_surface_override: None,
            },
        };

        let mut record = match invoker.invoke_agent(req, cancel).await {
            Ok(r) => r,
            Err(e) => {
                return Ok(tool_err(&call.call_id, format!("agent.invoke failed: {e}")));
            }
        };

        // Child turn rebinds L0 session; restore parent for subsequent tools.
        self.bind_session(parent_sid).await;

        let mut ok = matches!(record.state, qubit_protocol::InvocationState::Completed);
        // Cursor/Codex-style: empty child answer is a failed handoff, not success.
        // Mark not-ok so FAIL_CIRCUIT can strip blind retries and parent synthesizes.
        let empty_handoff = {
            let narrative = record
                .handoff_out
                .as_ref()
                .and_then(|h| h.narrative.as_deref())
                .unwrap_or("")
                .trim();
            narrative.is_empty()
                || narrative == "(no model response)"
                || narrative.contains("(no model response)")
                || narrative.contains("(no answer_text)")
        };
        let mut summary = format!(
            "invoke {} → {} ({})",
            callee_raw,
            record.state.as_wire(),
            record.child_session_id
        );
        let mut error_code = if ok {
            None
        } else {
            Some("invoke_failed".into())
        };
        if ok && empty_handoff {
            ok = false;
            error_code = Some("empty_handoff".into());
            summary.push_str(
                " — EMPTY_HANDOFF: child returned no usable answer. \
                 Do NOT retry the same goal/callee; synthesize with [数据缺口] or narrow the ask once.",
            );
            if let Some(ref mut h) = record.handoff_out {
                h.narrative = Some(
                    "EMPTY_HANDOFF: no usable child answer — parent must synthesize gaps; do not blind-retry same goal."
                        .into(),
                );
            }
        }

        Ok(ToolResult {
            call_id: ToolCallId::new(call.call_id.clone()),
            ok,
            observation: Some(json!({
                "summary": summary,
                "invocation_id": invocation_id.as_str(),
                "callee_spec_id": callee_raw,
                "child_session_id": record.child_session_id.as_str(),
                "child_turn_id": record.child_turn_id.as_str(),
                "state": record.state.as_wire(),
                "handoff_out": record.handoff_out,
                "delivery": record.delivery,
                "empty_handoff": empty_handoff,
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
            error_code,
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
        let mut out = Vec::with_capacity(calls.len());
        let mut rest = Vec::new();
        let mut rest_idx = Vec::new();
        for (i, c) in calls.into_iter().enumerate() {
            let name = c.name.strip_prefix("tool/").unwrap_or(&c.name);
            if name == "update_plan" {
                out.push((i, self.handle_update_plan(&c).await?));
            } else if name == "agent.invoke" {
                out.push((i, self.handle_agent_invoke(&c, cancel.child()).await?));
            } else {
                rest_idx.push(i);
                rest.push(c);
            }
        }
        if !rest.is_empty() {
            let fallback = self.fallback.invoke_all(rest, cancel).await?;
            for (i, r) in rest_idx.into_iter().zip(fallback.into_iter()) {
                out.push((i, r));
            }
        }
        out.sort_by_key(|(i, _)| *i);
        Ok(out.into_iter().map(|(_, r)| r).collect())
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn update_plan_auto_fills_missing_step_ids() {
        let plan = parse_update_plan_args(&json!({
            "steps": [
                { "title": "查行情", "status": "pending" },
                { "title": "写结论", "status": "in_progress" }
            ]
        }))
        .unwrap();
        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[0].id, "s1");
        assert_eq!(plan.steps[1].id, "s2");
        assert_eq!(plan.steps[0].title, "查行情");
        assert_eq!(plan.steps[1].status, PlanStepStatus::InProgress);
    }

    #[test]
    fn update_plan_title_falls_back_to_text() {
        let plan = parse_update_plan_args(&json!({
            "steps": [{ "text": "only text field" }]
        }))
        .unwrap();
        assert_eq!(plan.steps[0].id, "s1");
        assert_eq!(plan.steps[0].title, "only text field");
    }

    #[test]
    fn update_plan_mode_plan_forces_pending() {
        let plan = parse_update_plan_args(&json!({
            "mode": "plan",
            "steps": [{ "id": "a", "title": "x", "status": "done" }]
        }))
        .unwrap();
        assert_eq!(plan.steps[0].status, PlanStepStatus::Pending);
    }

    #[test]
    fn update_plan_session_goal_keeps_done_despite_args_mode_plan() {
        let plan = parse_update_plan_args_for_session(
            &json!({
                "mode": "plan",
                "steps": [{ "id": "a", "title": "x", "status": "done" }]
            }),
            Some(InteractionMode::Goal),
        )
        .unwrap();
        assert_eq!(plan.steps[0].status, PlanStepStatus::Done);
    }

    fn sample_specs() -> Vec<AgentSpec> {
        use qubit_protocol::ExecutionKind;
        vec![
            AgentSpec {
                id: AgentSpecId::new("def-news-event"),
                version: "1".into(),
                display_name: "新闻事件".into(),
                execution_kind: ExecutionKind::Subagent,
                labels: vec!["news_event".into(), "events".into()],
                identity_prompt_ref: "x".into(),
                system_prompt: None,
                default_recipe_id: None,
                tool_surface_ref: "t".into(),
                model_ref: None,
                max_iterations: 5,
                hitl_profile_ref: None,
                allowed_callers: vec![],
                triggers: vec![],
                enabled: true,
            },
            AgentSpec {
                id: AgentSpecId::new("def-market-data"),
                version: "1".into(),
                display_name: "行情数据".into(),
                execution_kind: ExecutionKind::Subagent,
                labels: vec!["market_data".into()],
                identity_prompt_ref: "x".into(),
                system_prompt: None,
                default_recipe_id: None,
                tool_surface_ref: "t".into(),
                model_ref: None,
                max_iterations: 5,
                hitl_profile_ref: None,
                allowed_callers: vec![],
                triggers: vec![],
                enabled: true,
            },
        ]
    }

    #[test]
    fn agent_invoke_extracts_aliases() {
        assert_eq!(
            extract_agent_invoke_callee_hint(&json!({"role": "news_event", "goal": "g"}))
                .as_deref(),
            Some("news_event")
        );
        assert_eq!(
            extract_agent_invoke_callee_hint(&json!({"agent": {"id": "def-news-event"}}))
                .as_deref(),
            Some("def-news-event")
        );
        assert_eq!(
            extract_agent_invoke_goal(&json!({"task": "拉取新闻"})).as_deref(),
            Some("拉取新闻")
        );
    }

    #[test]
    fn agent_invoke_resolves_role_and_display_name() {
        let specs = sample_specs();
        assert_eq!(
            resolve_callee_spec_id("news_event", &specs).as_deref(),
            Some("def-news-event")
        );
        assert_eq!(
            resolve_callee_spec_id("新闻事件", &specs).as_deref(),
            Some("def-news-event")
        );
        assert_eq!(
            resolve_callee_spec_id("news", &specs).as_deref(),
            Some("def-news-event")
        );
    }

    #[test]
    fn agent_invoke_infers_news_from_goal() {
        let specs = sample_specs();
        assert_eq!(
            infer_callee_from_goal("你再去互联网上拉取一下新闻，验证一下你的结论", &specs)
                .as_deref(),
            Some("def-news-event")
        );
    }
}
