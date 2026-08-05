//! L0 tool-path `agent.invoke` + session.snapshot invocations ledger.

use qubit_protocol::{
    AgentSpecId, InteractionMode, InvocationState, SessionCreate, SessionGet, TurnStart, UserInput,
};
use qubit_runtime::{
    CoreRuntimeService, NormalizedToolCall, SampleResponse, ScriptedModelClient,
};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn l0_agent_invoke_tool_records_on_parent_snapshot() {
    let scripted = ScriptedModelClient::sequence(vec![
        SampleResponse {
            text: "delegating".into(),
            tool_calls: vec![NormalizedToolCall {
                call_id: "tc_inv".into(),
                name: "agent.invoke".into(),
                args: json!({
                    "callee_spec_id": "def-research-sub",
                    "goal": "summarize AAPL",
                    "max_iterations": 2
                }),
            }],
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
            ..Default::default()
        },
        // Child turn consumes next sample(s).
        SampleResponse {
            text: "child research note".into(),
            tool_calls: vec![],
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
            ..Default::default()
        },
        SampleResponse {
            text: "parent done after invoke".into(),
            tool_calls: vec![],
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
            ..Default::default()
        },
    ]);
    let rt = CoreRuntimeService::new_with_model(Arc::new(scripted));
    rt.seed_defaults().await;

    let parent = rt
        .create_session(SessionCreate {
            workspace_id: Some(qubit_protocol::WorkspaceId::new("ws_l0_inv")),
            agent_ref: AgentSpecId::new("def-primary"),
            interaction_mode: InteractionMode::Agent,
            mode: None,
        })
        .await
        .unwrap();

    let started = rt
        .start_turn(TurnStart {
            session_id: parent.session_id.clone(),
            input: UserInput {
                text: "please research".into(),
                attachments: vec![],
                client_meta: None,
            },
            idempotency_key: "l0-inv-1".into(),
        })
        .await
        .unwrap();

    rt.await_turn_terminal(&started.turn_id, Duration::from_secs(5))
        .await
        .unwrap();

    let snap = rt
        .session_snapshot(SessionGet {
            session_id: parent.session_id.clone(),
        })
        .await
        .unwrap();

    assert!(
        !snap.invocations.is_empty(),
        "expected parent snapshot to include invocations"
    );
    let inv = &snap.invocations[0];
    assert_eq!(inv.request.callee_spec_id.as_str(), "def-research-sub");
    assert_eq!(inv.state, InvocationState::Completed);
    assert_ne!(inv.child_session_id, parent.session_id);
}
