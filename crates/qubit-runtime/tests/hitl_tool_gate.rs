//! Core tool-batch HITL via client_meta.hitl.mode=always

use std::sync::Arc;
use std::time::Duration;

use qubit_protocol::{
    HitlInboxFilter, InteractionMode, SessionCreate, SessionGet, TurnStart, UserInput,
};
use qubit_runtime::{
    CoreRuntimeService, NormalizedToolCall, SampleResponse, ScriptedModelClient,
};
use serde_json::json;
use qubit_protocol::AgentSpecId;

#[tokio::test]
async fn always_mode_pauses_before_tools() {
    let scripted = ScriptedModelClient::sequence(vec![SampleResponse {
        text: "fetching".into(),
        tool_calls: vec![NormalizedToolCall {
            call_id: "tc1".into(),
            name: "update_plan".into(),
            args: json!({
                "mode": "plan",
                "steps": [{"id": "s1", "title": "x", "status": "pending"}]
            }),
        }],
        request_hitl: false,
        hitl_title: None,
        hitl_body: None,
        ..Default::default()
    }]);
    let rt = CoreRuntimeService::new_with_model(Arc::new(scripted));
    rt.seed_defaults().await;
    let session = rt
        .create_session(SessionCreate {
            workspace_id: None,
            agent_ref: AgentSpecId::new("def-primary"),
            interaction_mode: InteractionMode::Agent,
            mode: None,
        })
        .await
        .unwrap();

    let started = rt
        .start_turn(TurnStart {
            session_id: session.session_id.clone(),
            input: UserInput {
                text: "do something".into(),
                attachments: vec![],
                client_meta: Some(json!({"hitl":{"mode":"always"}})),
            },
            idempotency_key: "hitl-always-1".into(),
            context: None,
        })
        .await
        .unwrap();

    // Poll until awaiting_hitl (await_turn_terminal only watches Completed/Failed).
    let mut awaiting = false;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let snap = rt
            .session_snapshot(SessionGet {
                session_id: session.session_id.clone(),
            })
            .await
            .unwrap();
        if snap
            .active_turn
            .as_ref()
            .map(|t| t.state == qubit_protocol::TurnState::AwaitingHitl)
            .unwrap_or(false)
        {
            awaiting = true;
            break;
        }
    }
    assert!(awaiting, "turn must pause in awaiting_hitl before tools");
    let pending = rt
        .list_hitl_inbox(HitlInboxFilter {
            session_id: Some(session.session_id.clone()),
            pending_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!pending.is_empty(), "inbox must have pending HITL");
    assert!(pending[0].prompt.body.contains("update_plan") || pending[0].prompt.title.contains("工具"));
    let _ = started;
}

#[tokio::test]
async fn skip_once_allows_first_tool_batch_under_always() {
    let scripted = ScriptedModelClient::sequence(vec![
        SampleResponse {
            text: "fetching".into(),
            tool_calls: vec![NormalizedToolCall {
                call_id: "tc1".into(),
                name: "update_plan".into(),
                args: json!({
                    "mode": "plan",
                    "steps": [{"id": "s1", "title": "x", "status": "pending"}]
                }),
            }],
            ..Default::default()
        },
        SampleResponse {
            text: "done".into(),
            tool_calls: vec![],
            ..Default::default()
        },
    ]);
    let rt = CoreRuntimeService::new_with_model(Arc::new(scripted));
    rt.seed_defaults().await;
    let session = rt
        .create_session(SessionCreate {
            workspace_id: None,
            agent_ref: AgentSpecId::new("def-primary"),
            interaction_mode: InteractionMode::Agent,
            mode: None,
        })
        .await
        .unwrap();

    let started = rt
        .start_turn(TurnStart {
            session_id: session.session_id.clone(),
            input: UserInput {
                text: "continue".into(),
                attachments: vec![],
                client_meta: Some(json!({
                    "hitl": {"mode": "always", "skip_tool_gate_once": true}
                })),
            },
            idempotency_key: "hitl-skip-1".into(),
            context: None,
        })
        .await
        .unwrap();

    let done = rt
        .await_turn_terminal(&started.turn_id, Duration::from_secs(3))
        .await
        .expect("turn should complete when skip_once allows tools");
    assert!(matches!(
        done,
        qubit_protocol::RuntimeEvent::TurnCompleted { .. }
    ));
}
