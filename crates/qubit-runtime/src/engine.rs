//! Thin turn engine (01 §4.4 / §7) — M5: PolicySnapshot + DeliveryEvaluator + ledger.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use qubit_policy::{builtin_catalog, load_policy_snapshot, RecipeCatalog};
use qubit_protocol::{
    DeliveryVerdict, EffectLedger, ErrorObject, HitlChannelHint, HitlInboxId, HitlInboxItem,
    HitlInputKind, HitlPrompt, HitlPromptId, HitlSource, HitlInboxStatus, Lifecycle, ProtocolError,
    RuntimeEvent, SessionId, TurnId, TurnState, UserInput,
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
use crate::model::{ModelClient, SampleRequest};
use crate::store::{initial_turn, new_turn_id, SharedStore};
use crate::tools::{L0ToolHost, ToolHost};
use serde_json::json;

const TOOL_LOOP_HARNESS: &str = r#"

## 工具调用收敛（Harness · 强制）
1. 每轮最多并行 1–3 个必要工具；禁止无目的连打同一工具。
2. 同一工具（含相同参数）成功 ≤3 次后必须停手，用已有 observation 写中文终答。
3. mathjs / historical_prices / technical_indicator 禁止刷屏；算数优先一次表达式。
4. 有足够证据后下一轮只输出最终回答，不再发 tool_calls。
5. 宁可给出带 [待核实] 的部分结论，也不要无限取数直到超时。
"#;

fn stall_fingerprint(tool_name: &str, args: &serde_json::Value, key: &str) -> String {
    let bare = tool_name.strip_prefix("tool/").unwrap_or(tool_name);
    match key {
        "tool_fingerprint" => format!("{bare}|{}", args),
        "tool_market" => format!("{bare}|market"),
        _ => bare.to_string(),
    }
}

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
        if !policy_snap.tool_allowlist.is_empty() {
            // Soft intersect: keep tools that appear on allowlist OR are L0 meta.
            // MCP: keep `call_mcp` / `mcp:<server>:<tool>` when allowlist enables MCP.
            let allow_mcp = policy_snap.tool_allowlist.iter().any(|a| {
                a == "call_mcp" || a.starts_with("mcp:")
            });
            tool_names.retain(|n| {
                let bare = n.strip_prefix("tool/").unwrap_or(n);
                bare == "update_plan"
                    || bare == "agent.invoke"
                    || (allow_mcp && (bare == "call_mcp" || bare.starts_with("mcp:")))
                    || policy_snap.tool_allowlist.iter().any(|a| a == bare || a == n)
            });
            if tool_names.is_empty() {
                tool_names = self.tools.tool_names();
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
            })
            .await?;
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
                let prompt = HitlPrompt {
                    id: HitlPromptId::new(format!("hitl_{}", uuid::Uuid::new_v4().simple())),
                    turn_id: turn_id.clone(),
                    input_kind: HitlInputKind::ApproveOnly,
                    title: sample
                        .hitl_title
                        .unwrap_or_else(|| "Approval required".into()),
                    body: sample
                        .hitl_body
                        .unwrap_or_else(|| "Please approve to continue.".into()),
                    options: vec![],
                    hard_rule: false,
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
                    source: HitlSource::UserTurn,
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
                self.store
                    .set_active_turn(session_id, Some(turn.clone()))
                    .await?;

                let seq = self.events.next_seq().await;
                self.store.bump_event_seq(session_id, seq).await?;
                self.checkpoint(session_id, &turn, seq, Some(item)).await?;
                self.events
                    .emit(RuntimeEvent::HitlRequested {
                        prompt,
                        inbox_id: inbox_id.as_str().to_string(),
                        seq,
                    })
                    .await;

                return Ok((turn_id, TurnOutcome::AwaitingHitl { inbox_id }));
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

            turn.state = TurnState::Acting;
            self.store
                .set_active_turn(session_id, Some(turn.clone()))
                .await?;
            let seq = self.events.next_seq().await;
            self.checkpoint(session_id, &turn, seq, None).await?;

            let results = self
                .tools
                .invoke_all(sample.tool_calls.clone(), cancel.child())
                .await?;

            // Feed tool observations back into the next sample (OpenAI chat format).
            let assistant_tools: Vec<serde_json::Value> = sample
                .tool_calls
                .iter()
                .map(|c| {
                    json!({
                        "id": c.call_id,
                        "type": "function",
                        "function": {
                            "name": c.name,
                            "arguments": c.args.to_string(),
                        }
                    })
                })
                .collect();
            history.push(json!({
                "role": "assistant",
                "content": sample.text,
                "tool_calls": assistant_tools,
            }));
            for (call, result) in sample.tool_calls.iter().zip(results.iter()) {
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
                    let applies = stall.tools.is_empty()
                        || stall.tools.iter().any(|t| t == name || name.starts_with(t));
                    if applies && result.ok {
                        let fp = stall_fingerprint(name, &call.args, &stall.key);
                        let hits = stall_hits.entry(fp.clone()).or_insert(0);
                        *hits = hits.saturating_add(1);
                        if *hits >= stall.max_success {
                            tool_names.retain(|n| {
                                let bare = n.strip_prefix("tool/").unwrap_or(n);
                                bare != name && !bare.starts_with(name)
                            });
                            history.push(json!({
                                "role": "system",
                                "content": format!(
                                    "STALL_BUDGET: tool `{name}` (fingerprint) succeeded {hits} times. \
                                     Do NOT call it again. Write the final Chinese answer now using \
                                     observations already in this turn. No more tool_calls."
                                ),
                            }));
                        }
                    }
                }
            }

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
