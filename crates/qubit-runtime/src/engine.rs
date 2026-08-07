//! Thin turn engine (01 §4.4 / §7) — M5: PolicySnapshot + DeliveryEvaluator + ledger.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use qubit_policy::{builtin_catalog, load_policy_snapshot, RecipeCatalog};
use qubit_protocol::{
    DeliveryVerdict, EffectLedger, ErrorObject, HitlChannelHint, HitlInboxId, HitlInboxItem,
    HitlInputKind, HitlPrompt, HitlPromptId, HitlSource, HitlInboxStatus, Lifecycle, ProtocolError,
    RuntimeEvent, SessionId, ToolCallId, ToolResult, TurnId, TurnState, UserInput,
};

use crate::cancel::CancelToken;
use crate::checkpoint::{CheckpointRecord, CheckpointStore};
use crate::context::{
    ContextAssembler, DefaultContextAssembler, SlotAssembleInput, StaticIdentityLoader,
    WorkspaceFocus,
};
use crate::delivery::{DeliveryEvaluator, LedgerDeliveryEvaluator};
use crate::error::RuntimeError;
use crate::events::EventBus;
use crate::hitl_inbox::HitlInbox;
use crate::hitl_policy::{
    evaluate_tool_batch_hitl, extract_ai_hitl_hint, HitlPolicy, ToolHitlDecision,
};
use crate::model::{ModelClient, SampleRequest};
use crate::reasoning_extract::chunk_reasoning_for_stream;
use crate::stall::{
    is_fail_circuit_tool, stall_fingerprint, strip_tool_from_surface, FAIL_CIRCUIT_MAX,
};
use crate::store::{initial_turn, new_turn_id, SharedStore};
use crate::tools::{L0ToolHost, ToolHost};
use serde_json::json;

const TOOL_LOOP_HARNESS: &str = r#"

## 工具调用收敛（Harness · 强制）
1. 每轮最多并行 1–3 个必要工具；禁止无目的连打同一工具。
2. 同一工具（含相同参数指纹）成功 ≤3 次后必须停手，用已有 observation 写中文终答。
3. mathjs / historical_prices / technical_indicator 禁止刷屏；算数优先一次表达式。
4. 有足够证据后下一轮只输出最终回答，不再发 tool_calls。
5. 宁可给出带 [待核实] 的部分结论，也不要无限取数直到超时。
6. 若本轮已建立 update_plan 步骤：每完成一块工作必须再调 update_plan 推进 status（in_progress→done/skipped）；禁止计划一直停在全 pending。
7. 因子相关：只用点号工具名 factor.register / factor.compute / factor.autoEvaluate / factor.mine.llm；禁止 factor_register 等假名；参数平铺勿包 arguments；创建因子必须 register 落库，禁止只写口头因子表或把工具缺口当终答。
8. MCP 只用 `mcp:<server>:<tool>` 直连名；不要用 call_mcp 元工具。
9. workspace.context.snapshot / research.thesis.write 参数不全时不要反复重试——缺字段先补齐或改用其它路径。
"#;

/// Tools already exercised during context assembly when auto-recall / workspace
/// snapshot run. Only stripped when `TurnContextOpts.strip_bootstrap_memory_tools`.
const BOOTSTRAP_INJECTED_TOOLS: &[&str] = &[
    "memory.recall",
    "workspace.memory.search",
    "workspace.context.snapshot",
];

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
pub enum TurnOutcome {
    Finished { delivery: DeliveryVerdict },
    AwaitingHitl { inbox_id: HitlInboxId },
    Cancelled,
}

#[derive(Debug, Default)]
pub struct RunTurnOpts {
    pub max_iterations: Option<u32>,
    pub recipe_key: Option<String>,
    pub context: qubit_protocol::TurnContextOpts,
}

pub struct TurnEngine {
    store: SharedStore,
    models: Arc<dyn ModelClient>,
    tools: Arc<dyn ToolHost>,
    events: EventBus,
    hitl: Arc<dyn HitlInbox>,
    checkpoints: Option<Arc<dyn CheckpointStore>>,
    context: Arc<dyn ContextAssembler>,
    l0: Option<Arc<L0ToolHost>>,
    policy: RecipeCatalog,
    delivery: Arc<dyn DeliveryEvaluator>,
}

impl TurnEngine {
    pub fn new(
        store: SharedStore,
        models: Arc<dyn ModelClient>,
        tools: Arc<dyn ToolHost>,
        events: EventBus,
        hitl: Arc<dyn HitlInbox>,
    ) -> Self {
        let context: Arc<dyn ContextAssembler> = Arc::new(
            DefaultContextAssembler::with_empty_ports(Arc::new(StaticIdentityLoader)),
        );
        Self {
            store,
            models,
            tools,
            events,
            hitl,
            checkpoints: None,
            context,
            l0: None,
            policy: builtin_catalog(),
            delivery: Arc::new(LedgerDeliveryEvaluator),
        }
    }

    pub fn with_checkpoints(mut self, cp: Arc<dyn CheckpointStore>) -> Self {
        self.checkpoints = Some(cp);
        self
    }

    pub fn with_context(mut self, context: Arc<dyn ContextAssembler>) -> Self {
        self.context = context;
        self
    }

    pub fn with_l0(mut self, l0: Arc<L0ToolHost>) -> Self {
        self.l0 = Some(l0);
        self
    }

    pub fn with_policy(mut self, policy: RecipeCatalog) -> Self {
        self.policy = policy;
        self
    }

    pub fn with_delivery(mut self, delivery: Arc<dyn DeliveryEvaluator>) -> Self {
        self.delivery = delivery;
        self
    }

    pub fn events(&self) -> &EventBus {
        &self.events
    }

    /// Mark active turn failed + emit TurnFailed so Bun pollers do not hang until timeout.
    pub async fn fail_turn(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        err: &RuntimeError,
    ) -> Result<(), RuntimeError> {
        let mut turn = self
            .store
            .get_session(session_id)
            .await?
            .active_turn
            .unwrap_or_else(|| initial_turn(turn_id.clone()));
        if turn.turn_id != *turn_id {
            turn = initial_turn(turn_id.clone());
        }
        // Already terminal — leave as-is.
        if matches!(
            turn.state,
            TurnState::Completed | TurnState::Failed | TurnState::Cancelled | TurnState::AwaitingHitl
        ) {
            return Ok(());
        }
        turn.state = TurnState::Failed;
        turn.lifecycle = Some(Lifecycle::Failed);
        let message = err.to_string();
        if turn
            .answer_text
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            turn.answer_text = Some(format!("Prime Core turn failed: {message}"));
        }
        let delivery = DeliveryVerdict {
            status: qubit_protocol::DeliveryStatus::Failed,
            reasons: vec![message.clone()],
        };
        turn.delivery = Some(delivery);
        self.store
            .set_active_turn(session_id, Some(turn.clone()))
            .await?;
        let seq = self.events.next_seq().await;
        self.store.bump_event_seq(session_id, seq).await?;
        self.checkpoint(session_id, &turn, seq, None).await?;
        self.events
            .emit(RuntimeEvent::TurnFailed {
                turn_id: turn_id.clone(),
                error: ErrorObject {
                    code: "turn_failed".into(),
                    message,
                    data: None,
                },
                seq,
            })
            .await;
        Ok(())
    }

    /// If `turn_id` is still the active mid-flight turn, mark it failed (empty-run guard).
    pub async fn heal_orphan_turn(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        reason: &str,
    ) -> Result<(), RuntimeError> {
        let Some(turn) = self.store.get_session(session_id).await?.active_turn else {
            return Ok(());
        };
        if turn.turn_id != *turn_id {
            return Ok(());
        }
        if turn.state.is_terminal() || turn.state == TurnState::AwaitingHitl {
            return Ok(());
        }
        if !turn.state.is_orphan_recoverable() {
            return Ok(());
        }
        tracing::warn!(
            turn_id = %turn_id,
            state = ?turn.state,
            reason,
            "healing orphan mid-flight turn"
        );
        self.fail_turn(
            session_id,
            turn_id,
            &RuntimeError::Internal(reason.to_string()),
        )
        .await
    }

    async fn checkpoint(
        &self,
        session_id: &SessionId,
        turn: &qubit_protocol::TurnView,
        seq: u64,
        hitl: Option<HitlInboxItem>,
    ) -> Result<(), RuntimeError> {
        let Some(cp) = &self.checkpoints else {
            return Ok(());
        };
        let session = self.store.get_session(session_id).await?.view;
        cp.save(&CheckpointRecord {
            session_id: session_id.clone(),
            turn_id: turn.turn_id.clone(),
            seq,
            state: turn.state,
            iteration: turn.iteration,
            turn: turn.clone(),
            session,
            hitl,
            updated_at_ms: now_ms(),
        })
        .await
    }

    /// Pause turn into AwaitingHitl + enqueue inbox item (shared by model flag / tool policy / AI hint).
    async fn raise_hitl(
        &self,
        session_id: &SessionId,
        session: &crate::store::SessionRecord,
        turn: &mut qubit_protocol::TurnView,
        turn_id: &TurnId,
        title: String,
        body: String,
        hard_rule: bool,
        source: HitlSource,
    ) -> Result<(TurnId, TurnOutcome), RuntimeError> {
        let prompt = HitlPrompt {
            id: HitlPromptId::new(format!("hitl_{}", uuid::Uuid::new_v4().simple())),
            turn_id: turn_id.clone(),
            input_kind: HitlInputKind::ApproveOnly,
            title,
            body,
            options: vec![],
            hard_rule,
            created_at: now_ms(),
        };
        let inbox_id = HitlInboxId::new(format!("inbox_{}", uuid::Uuid::new_v4().simple()));
        let item = HitlInboxItem {
            inbox_id: inbox_id.clone(),
            prompt: prompt.clone(),
            workspace_id: session.view.workspace_id.clone(),
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            agent_instance_id: session.view.agent_instance_id.clone(),
            execution_kind: session.view.execution_kind,
            source,
            status: HitlInboxStatus::Pending,
            created_at_ms: now_ms(),
            expires_at_ms: None,
            channel_hints: vec![HitlChannelHint::IdePanel],
        };
        self.hitl.enqueue(item.clone()).await?;
        if let Some(cp) = &self.checkpoints {
            cp.save_hitl(&item).await?;
        }

        turn.state = TurnState::AwaitingHitl;
        turn.lifecycle = Some(Lifecycle::AwaitingHitl);
        if turn
            .answer_text
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            turn.answer_text = Some(item.prompt.body.clone());
        }
        self.store
            .set_active_turn(session_id, Some(turn.clone()))
            .await?;

        let seq = self.events.next_seq().await;
        self.store.bump_event_seq(session_id, seq).await?;
        self.checkpoint(session_id, turn, seq, Some(item)).await?;
        self.events
            .emit(RuntimeEvent::HitlRequested {
                prompt,
                inbox_id: inbox_id.as_str().to_string(),
                seq,
            })
            .await;

        Ok((turn_id.clone(), TurnOutcome::AwaitingHitl { inbox_id }))
    }

    pub async fn run_turn(
        &self,
        session_id: &SessionId,
        input: UserInput,
        cancel: CancelToken,
    ) -> Result<(TurnId, TurnOutcome), RuntimeError> {
        self.run_turn_with_opts(session_id, input, cancel, RunTurnOpts::default())
            .await
    }

    pub async fn run_turn_with_opts(
        &self,
        session_id: &SessionId,
        input: UserInput,
        cancel: CancelToken,
        opts: RunTurnOpts,
    ) -> Result<(TurnId, TurnOutcome), RuntimeError> {
        let turn_id = new_turn_id();
        self.run_turn_inner(session_id, turn_id, input, cancel, opts)
            .await
    }

    /// Run with a pre-allocated turn id (M6: register cancel before spawn).
    pub async fn run_turn_preallocated(
        &self,
        session_id: &SessionId,
        turn_id: TurnId,
        input: UserInput,
        cancel: CancelToken,
        opts: RunTurnOpts,
    ) -> Result<(TurnId, TurnOutcome), RuntimeError> {
        self.run_turn_inner(session_id, turn_id, input, cancel, opts)
            .await
    }

    async fn run_turn_inner(
        &self,
        session_id: &SessionId,
        turn_id: TurnId,
        input: UserInput,
        cancel: CancelToken,
        opts: RunTurnOpts,
    ) -> Result<(TurnId, TurnOutcome), RuntimeError> {
        let session = self.store.get_session(session_id).await?;
        let mut hitl_policy = HitlPolicy::from_client_meta(input.client_meta.as_ref());
        let spec = self.store.get_spec(&session.view.agent_spec_id).await?;
        let mode = session.view.interaction_mode;
        let mut turn = initial_turn(turn_id.clone());
        self.store
            .set_active_turn(session_id, Some(turn.clone()))
            .await?;

        if let Some(ref l0) = self.l0 {
            l0.bind_session(session_id.clone()).await;
        }
        self.tools
            .bind_turn_context(session.view.workspace_id.as_str(), session_id)
            .await;

        let recipe_key = opts
            .recipe_key
            .or(spec.default_recipe_id.clone());
        let policy_snap = load_policy_snapshot(&self.policy, recipe_key.as_deref())
            .map_err(|e| RuntimeError::Internal(e.to_string()))?;
        let mut ledger = EffectLedger::default();
        let max_iterations = opts
            .max_iterations
            .unwrap_or(spec.max_iterations)
            .max(1);

        let seq = self.events.next_seq().await;
        self.store.bump_event_seq(session_id, seq).await?;
        self.events
            .emit(RuntimeEvent::TurnStarted {
                turn_id: turn_id.clone(),
                seq,
                ts: now_ms(),
            })
            .await;

        turn.state = TurnState::Preparing;
        self.store
            .set_active_turn(session_id, Some(turn.clone()))
            .await?;
        self.checkpoint(session_id, &turn, seq, None).await?;

        let mut tool_names = self.tools.tool_names();
        // Single MCP channel: advertise `mcp:<server>:<tool>` only (call_mcp still invokable if forced).
        tool_names.retain(|n| {
            let bare = n.strip_prefix("tool/").unwrap_or(n);
            bare != "call_mcp"
        });
        if !policy_snap.tool_allowlist.is_empty() {
            // Soft intersect: keep tools that appear on allowlist OR are L0 meta.
            // MCP: keep `mcp:<server>:<tool>` when allowlist enables MCP.
            let allow_mcp = policy_snap.tool_allowlist.iter().any(|a| {
                a == "call_mcp" || a.starts_with("mcp:")
            });
            tool_names.retain(|n| {
                let bare = n.strip_prefix("tool/").unwrap_or(n);
                bare == "update_plan"
                    || bare == "agent.invoke"
                    || (allow_mcp && bare.starts_with("mcp:"))
                    || policy_snap.tool_allowlist.iter().any(|a| a == bare || a == n)
            });
            if tool_names.is_empty() {
                tool_names = self
                    .tools
                    .tool_names()
                    .into_iter()
                    .filter(|n| {
                        let bare = n.strip_prefix("tool/").unwrap_or(n);
                        bare != "call_mcp"
                    })
                    .collect();
            }
        }

        let envelope = self
            .context
            .build(SlotAssembleInput {
                session: session.view.clone(),
                spec: spec.clone(),
                goal_text: input.text.clone(),
                tool_names: tool_names.clone(),
                working: None,
                decision_cutoff: None,
                focus: WorkspaceFocus::default(),
                context: opts.context.clone(),
            })
            .await?;
        if opts.context.strip_bootstrap_memory_tools() {
            tool_names.retain(|n| {
                let bare = n.strip_prefix("tool/").unwrap_or(n);
                !BOOTSTRAP_INJECTED_TOOLS.iter().any(|t| *t == bare)
            });
        }
        let rendered = envelope.rendered.clone().unwrap_or_default();
        let mut system = if rendered.system.is_empty() {
            format!(
                "You are agent {} ({:?}). mode={}",
                spec.display_name, spec.execution_kind, mode.as_str()
            )
        } else {
            rendered.system
        };
        // Policy checklist + hard tool-loop harness (Core identity may be stub without Bun prompts).
        if !policy_snap.checklist_prompt.is_empty() {
            system.push_str("\n\n## Policy checklist（强制）\n");
            for line in &policy_snap.checklist_prompt {
                system.push_str("- ");
                system.push_str(line);
                system.push('\n');
            }
        }
        system.push_str(TOOL_LOOP_HARNESS);
        let user = if rendered.user.is_empty() {
            input.text.clone()
        } else {
            rendered.user
        };

        let mut last_text = String::new();
        let mut iteration = 0u32;
        let mut history: Vec<serde_json::Value> = Vec::new();
        // tool_fingerprint → consecutive success count (stall budget)
        let mut stall_hits: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        // identical failure fingerprint → fail-circuit strip
        let mut fail_hits: std::collections::HashMap<String, u32> =
            std::collections::HashMap::new();
        let stall = policy_snap.stall.clone();
        loop {
            if let Err(RuntimeError::Cancelled) = cancel.check() {
                if !last_text.trim().is_empty() {
                    turn.answer_text = Some(last_text.clone());
                }
                turn.state = TurnState::Cancelled;
                turn.lifecycle = Some(Lifecycle::Cancelled);
                let delivery = DeliveryVerdict {
                    status: qubit_protocol::DeliveryStatus::Cancelled,
                    reasons: vec!["turn_cancelled".into()],
                };
                turn.delivery = Some(delivery.clone());
                self.store
                    .set_active_turn(session_id, Some(turn.clone()))
                    .await?;
                let seq = self.events.next_seq().await;
                self.checkpoint(session_id, &turn, seq, None).await?;
                self.events
                    .emit(RuntimeEvent::TurnCompleted {
                        turn_id: turn_id.clone(),
                        lifecycle: Lifecycle::Cancelled,
                        delivery,
                        seq,
                    })
                    .await;
                return Ok((turn_id, TurnOutcome::Cancelled));
            }
            iteration += 1;
            if iteration > max_iterations {
                break;
            }

            turn.state = TurnState::Reasoning;
            turn.iteration = iteration;
            self.store
                .set_active_turn(session_id, Some(turn.clone()))
                .await?;
            let seq = self.events.next_seq().await;
            self.checkpoint(session_id, &turn, seq, None).await?;

            let sample = match self
                .models
                .sample(
                    SampleRequest {
                        system: system.clone(),
                        user: user.clone(),
                        tools: tool_names.clone(),
                        history: history.clone(),
                    },
                    cancel.child(),
                )
                .await
            {
                Ok(s) => s,
                Err(RuntimeError::Cancelled) => {
                    if !last_text.trim().is_empty() {
                        turn.answer_text = Some(last_text.clone());
                    }
                    turn.state = TurnState::Cancelled;
                    turn.lifecycle = Some(Lifecycle::Cancelled);
                    let delivery = DeliveryVerdict {
                        status: qubit_protocol::DeliveryStatus::Cancelled,
                        reasons: vec!["turn_cancelled".into()],
                    };
                    turn.delivery = Some(delivery.clone());
                    self.store
                        .set_active_turn(session_id, Some(turn.clone()))
                        .await?;
                    let seq = self.events.next_seq().await;
                    self.checkpoint(session_id, &turn, seq, None).await?;
                    self.events
                        .emit(RuntimeEvent::TurnCompleted {
                            turn_id: turn_id.clone(),
                            lifecycle: Lifecycle::Cancelled,
                            delivery,
                            seq,
                        })
                        .await;
                    return Ok((turn_id, TurnOutcome::Cancelled));
                }
                Err(e) => return Err(e),
            };

            {
                let mut stats = turn.llm_stats.take().unwrap_or_default();
                stats.add_sample(
                    sample.prompt_tokens,
                    sample.completion_tokens,
                    sample.total_tokens,
                    sample.latency_ms,
                    sample.model.clone(),
                    sample.provider.clone(),
                );
                turn.llm_stats = Some(stats);
            }

            // Hidden reasoning first (UI ghost); never treat as answer text.
            if let Some(reasoning) = sample
                .reasoning_text
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                for chunk in chunk_reasoning_for_stream(reasoning, 96) {
                    let seq = self.events.next_seq().await;
                    self.store.bump_event_seq(session_id, seq).await?;
                    self.events
                        .emit(RuntimeEvent::ReasoningToken {
                            turn_id: turn_id.clone(),
                            iteration,
                            text: chunk,
                            seq,
                        })
                        .await;
                }
            }

            if !sample.text.is_empty() {
                last_text = sample.text.clone();
                let seq = self.events.next_seq().await;
                self.store.bump_event_seq(session_id, seq).await?;
                self.events
                    .emit(RuntimeEvent::Token {
                        turn_id: turn_id.clone(),
                        iteration,
                        text: sample.text.clone(),
                        seq,
                    })
                    .await;
            }

            if sample.request_hitl {
                return self
                    .raise_hitl(
                        session_id,
                        &session,
                        &mut turn,
                        &turn_id,
                        sample
                            .hitl_title
                            .unwrap_or_else(|| "Approval required".into()),
                        sample
                            .hitl_body
                            .unwrap_or_else(|| "Please approve to continue.".into()),
                        false,
                        HitlSource::UserTurn,
                    )
                    .await;
            }

            // mode=ai：模型可用 ---HITL_HINT_JSON--- 主动请求审批（无工具时也可）。
            if matches!(hitl_policy.mode, crate::hitl_policy::HitlMode::Ai) {
                if let Some((title, body)) = extract_ai_hitl_hint(&sample.text) {
                    return self
                        .raise_hitl(
                            session_id,
                            &session,
                            &mut turn,
                            &turn_id,
                            title,
                            body,
                            false,
                            HitlSource::UserTurn,
                        )
                        .await;
                }
            }

            if sample.tool_calls.is_empty() {
                break;
            }

            for call in &sample.tool_calls {
                if !mode.allows_tool(&call.name) {
                    return Err(ProtocolError::AdmissionDenied {
                        message: format!(
                            "tool `{}` denied in interaction_mode={}",
                            call.name,
                            mode.as_str()
                        ),
                    }
                    .into());
                }
            }

            // Tool-batch HITL（always / 高危）—— 在 invoke 之前升起，由 Bun 投影到前端。
            let tool_decision: ToolHitlDecision =
                evaluate_tool_batch_hitl(&hitl_policy, &sample.tool_calls);
            // skip_once 只放过本回合第一批工具；后续批次仍按 mode 评估。
            hitl_policy.skip_tool_gate_once = false;
            if tool_decision.trigger {
                return self
                    .raise_hitl(
                        session_id,
                        &session,
                        &mut turn,
                        &turn_id,
                        tool_decision.title,
                        tool_decision.body,
                        tool_decision.hard_rule,
                        HitlSource::Invocation,
                    )
                    .await;
            }

            turn.state = TurnState::Acting;
            self.store
                .set_active_turn(session_id, Some(turn.clone()))
                .await?;
            let seq = self.events.next_seq().await;
            self.checkpoint(session_id, &turn, seq, None).await?;

            // Whole-batch ceiling: per-tool soft timeout alone can still leave Acting
            // stuck if the host future never settles (lost bridge ack, etc.).
            let acting_secs: u64 = std::env::var("QUBIT_ACTING_TIMEOUT_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(180)
                .clamp(30, 600);
            let invoke_fut = self
                .tools
                .invoke_all(sample.tool_calls.clone(), cancel.child());
            let results = match tokio::time::timeout(
                std::time::Duration::from_secs(acting_secs),
                invoke_fut,
            )
            .await
            {
                Ok(r) => r?,
                Err(_) => {
                    tracing::warn!(
                        turn_id = %turn_id,
                        secs = acting_secs,
                        tools = sample.tool_calls.len(),
                        "acting batch timed out; soft-failing tool results"
                    );
                    sample
                        .tool_calls
                        .iter()
                        .map(|c| ToolResult {
                            call_id: ToolCallId::new(c.call_id.clone()),
                            ok: false,
                            observation: Some(serde_json::json!({
                                "ok": false,
                                "error": format!(
                                    "acting batch timeout after {acting_secs}s"
                                ),
                                "error_code": "acting_batch_timeout",
                            })),
                            effects: vec![],
                            retryable: true,
                            error_code: Some("acting_batch_timeout".into()),
                        })
                        .collect()
                }
            };

            // Feed tool observations back into the next sample (OpenAI chat format).
            // CRITICAL: every assistant tool_calls message must be followed ONLY by the
            // matching tool role messages (one per tool_call_id). Stall/fail nudges must
            // come AFTER the full tool block — inserting system mid-block causes HTTP 400
            // "insufficient tool messages following tool_calls message" (DeepSeek/OpenAI).
            let assistant_tools: Vec<serde_json::Value> = sample
                .tool_calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c.call_id,
                        "type": "function",
                        "function": {
                            // Re-encode so history matches what the API advertised.
                            "name": crate::model_openai::encode_openai_tool_name(&c.name),
                            "arguments": c.args.to_string(),
                        }
                    })
                })
                .collect();
            history.push(json!({
                "role": "assistant",
                // Providers reject empty-string content alongside tool_calls; prefer null.
                "content": if sample.text.trim().is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::Value::String(sample.text.clone())
                },
                "tool_calls": assistant_tools,
            }));

            let mut pending_nudges: Vec<serde_json::Value> = Vec::new();
            for call in &sample.tool_calls {
                let result = results
                    .iter()
                    .find(|r| r.call_id.as_str() == call.call_id)
                    .or_else(|| {
                        // Fallback: positional if host preserved order but remapped ids.
                        let idx = sample
                            .tool_calls
                            .iter()
                            .position(|c| c.call_id == call.call_id)?;
                        results.get(idx)
                    });
                let Some(result) = result else {
                    history.push(json!({
                        "role": "tool",
                        "tool_call_id": call.call_id,
                        "content": json!({
                            "ok": false,
                            "error": "missing_tool_result"
                        }).to_string(),
                    }));
                    continue;
                };
                let name = call.name.strip_prefix("tool/").unwrap_or(&call.name);
                ledger.record_tool_results(name, result.ok, result.effects.clone());
                let content = result
                    .observation
                    .as_ref()
                    .map(|o| o.to_string())
                    .unwrap_or_else(|| {
                        if result.ok {
                            json!({"ok": true}).to_string()
                        } else {
                            json!({
                                "ok": false,
                                "error": result.error_code.clone().unwrap_or_else(|| "tool_failed".into())
                            })
                            .to_string()
                        }
                    });
                history.push(json!({
                    "role": "tool",
                    "tool_call_id": call.call_id,
                    "content": content,
                }));

                // Stall budget: consecutive same tool/fingerprint successes → strip + nudge.
                if let Some(ref stall) = stall {
                    let family = crate::stall::tool_family(name, &call.args);
                    let applies = stall.tools.is_empty()
                        || stall.tools.iter().any(|t| {
                            t == name
                                || name.starts_with(t)
                                || t == &family
                                || family.starts_with(t)
                                || (*t == "call_mcp" && family.starts_with("mcp:"))
                        });
                    if applies && result.ok {
                        let fp = stall_fingerprint(name, &call.args, &stall.key);
                        let hits = stall_hits.entry(fp.clone()).or_insert(0);
                        *hits = hits.saturating_add(1);
                        if *hits >= stall.max_success {
                            strip_tool_from_surface(&mut tool_names, name, &call.args);
                            pending_nudges.push(json!({
                                "role": "system",
                                "content": format!(
                                    "STALL_BUDGET: tool `{family}` (fingerprint) succeeded {hits} times. \
                                     Do NOT call it again (neither mcp:* nor call_mcp). Write the final \
                                     Chinese answer now using observations already in this turn. No more tool_calls."
                                ),
                            }));
                        }
                    }
                }

                // Fail circuit: repeated identical failures on control tools → strip + nudge.
                if !result.ok && is_fail_circuit_tool(name) {
                    let fp = stall_fingerprint(name, &call.args, "tool_fingerprint");
                    let hits = fail_hits.entry(fp.clone()).or_insert(0);
                    *hits = hits.saturating_add(1);
                    if *hits >= FAIL_CIRCUIT_MAX {
                        strip_tool_from_surface(&mut tool_names, name, &call.args);
                        pending_nudges.push(json!({
                            "role": "system",
                            "content": format!(
                                "FAIL_CIRCUIT: tool `{name}` failed {hits} times with the same args. \
                                 It has been removed from this turn's tool surface. Do not retry it; \
                                 fix missing fields in prose or continue with another path / final answer."
                            ),
                        }));
                    }
                }
            }
            history.extend(pending_nudges);

            turn.state = TurnState::Observing;
            self.store
                .set_active_turn(session_id, Some(turn))
                .await?;
            turn = self
                .store
                .get_session(session_id)
                .await?
                .active_turn
                .unwrap();
            let seq = self.events.next_seq().await;
            self.checkpoint(session_id, &turn, seq, None).await?;
        }

        let answer = if last_text.trim().is_empty() {
            // Never dump input.text / assembled context into the user-facing answer.
            "(no model response)".to_string()
        } else {
            last_text
        };
        ledger.answer_text = Some(answer.clone());
        turn.answer_text = Some(answer);

        turn.state = TurnState::Completed;
        turn.lifecycle = Some(Lifecycle::Completed);
        let delivery = self.delivery.evaluate(&policy_snap, &ledger, &turn);
        turn.delivery = Some(delivery.clone());
        self.store
            .set_active_turn(session_id, Some(turn.clone()))
            .await?;

        let seq = self.events.next_seq().await;
        self.store.bump_event_seq(session_id, seq).await?;
        self.checkpoint(session_id, &turn, seq, None).await?;
        self.events
            .emit(RuntimeEvent::TurnCompleted {
                turn_id: turn_id.clone(),
                lifecycle: Lifecycle::Completed,
                delivery: delivery.clone(),
                seq,
            })
            .await;

        Ok((turn_id, TurnOutcome::Finished { delivery }))
    }
}
