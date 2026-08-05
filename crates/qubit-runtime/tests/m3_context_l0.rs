use std::sync::Arc;
use std::time::Duration;

use qubit_protocol::{
    AgentPlanStep, AgentSpecId, InteractionMode, PlanStepStatus, SessionCreate, TurnStart,
    UserInput,
};
use qubit_runtime::{
    ContextAssembler, CoreRuntimeService, DefaultContextAssembler, MockIdentityLoader,
    NormalizedToolCall, SampleResponse, ScriptedModelClient, SlotAssembleInput,
    StaticIdentityLoader, WorkspaceFocus,
};
use serde_json::json;

#[tokio::test]
async fn context_assembler_renders_slots() {
    let asm = DefaultContextAssembler::with_empty_ports(Arc::new(MockIdentityLoader {
        text: "IDENTITY_LINE".into(),
    }));
    let rt = CoreRuntimeService::new_for_test();
    rt.seed_defaults().await;
    let session = rt
        .create_session(SessionCreate {
            workspace_id: None,
            agent_ref: AgentSpecId::new("def-primary"),
            interaction_mode: InteractionMode::Plan,
            mode: None,
        })
        .await
        .unwrap();
    let spec = rt.store().get_spec(&session.agent_spec_id).await.unwrap();
    let env = asm
        .build(SlotAssembleInput {
            session,
            spec,
            goal_text: "design factor pipeline".into(),
            tool_names: vec!["update_plan".into()],
            working: None,
            decision_cutoff: None,
            focus: WorkspaceFocus::default(),
        })
        .await
        .unwrap();
    let rendered = env.rendered.unwrap();
    assert!(rendered.system.contains("IDENTITY_LINE"));
    assert!(rendered.system.contains("MODE=plan") || rendered.user.contains("MODE=plan") || rendered.system.contains("plan") || env.slots.contains_key("control"));
    assert!(rendered.user.contains("design factor pipeline") || env.slots.get("goal").is_some());
    assert!(env.slots.contains_key("identity"));
    assert!(env.slots.contains_key("goal"));
}

#[tokio::test]
async fn update_plan_l0_persists_on_session() {
    let plan_args = json!({
        "mode": "plan",
        "steps": [
            {"id": "s1", "title": "fetch data", "status": "pending"},
            {"id": "s2", "title": "run backtest", "status": "pending"}
        ]
    });
    let scripted = ScriptedModelClient::sequence(vec![
        SampleResponse {
            text: "I'll write a plan.".into(),
            tool_calls: vec![NormalizedToolCall {
                call_id: "tc1".into(),
                name: "update_plan".into(),
                args: plan_args,
            }],
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
            ..Default::default()
        },
        SampleResponse {
            text: "plan ready".into(),
            tool_calls: vec![],
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
            ..Default::default()
        },
    ]);
    let rt = CoreRuntimeService::new_with_model(Arc::new(scripted));
    rt.seed_defaults().await;
    let session = rt
        .create_session(SessionCreate {
            workspace_id: None,
            agent_ref: AgentSpecId::new("def-primary"),
            interaction_mode: InteractionMode::Plan,
            mode: Some("plan".into()),
        })
        .await
        .unwrap();
    assert_eq!(session.interaction_mode, InteractionMode::Plan);

    let started = rt
        .start_turn(TurnStart {
            session_id: session.session_id.clone(),
            input: UserInput {
                text: "make a plan".into(),
                attachments: vec![],
                client_meta: None,
            },
            idempotency_key: "plan-1".into(),
        })
        .await
        .unwrap();
    rt.await_turn_terminal(&started.turn_id, Duration::from_secs(2))
        .await
        .unwrap();

    let plan = rt.store().get_plan(&session.session_id).await.unwrap();
    let plan = plan.expect("plan saved");
    assert_eq!(plan.steps.len(), 2);
    assert_eq!(plan.steps[0].title, "fetch data");
    assert_eq!(plan.steps[0].status, PlanStepStatus::Pending);
}

#[tokio::test]
async fn update_plan_l0_accepts_steps_without_id() {
    let plan_args = json!({
        "steps": [
            {"title": "resolve symbol", "status": "pending"},
            {"title": "fetch snapshot", "status": "in_progress"}
        ]
    });
    let scripted = ScriptedModelClient::sequence(vec![
        SampleResponse {
            text: "planning".into(),
            tool_calls: vec![NormalizedToolCall {
                call_id: "tc1".into(),
                name: "update_plan".into(),
                args: plan_args,
            }],
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
            ..Default::default()
        },
        SampleResponse {
            text: "ok".into(),
            tool_calls: vec![],
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
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
            mode: Some("agent".into()),
        })
        .await
        .unwrap();

    let started = rt
        .start_turn(TurnStart {
            session_id: session.session_id.clone(),
            input: UserInput {
                text: "continue research".into(),
                attachments: vec![],
                client_meta: None,
            },
            idempotency_key: "plan-noid-1".into(),
        })
        .await
        .unwrap();
    rt.await_turn_terminal(&started.turn_id, Duration::from_secs(2))
        .await
        .unwrap();

    let snap = rt.store().get_session(&session.session_id).await.unwrap();
    let turn = snap.active_turn.expect("turn");
    assert!(
        !turn
            .answer_text
            .as_deref()
            .unwrap_or("")
            .contains("Prime Core turn failed"),
        "turn should not fail on missing step id: {:?}",
        turn.answer_text
    );
    let plan = rt
        .store()
        .get_plan(&session.session_id)
        .await
        .unwrap()
        .expect("plan saved");
    assert_eq!(plan.steps.len(), 2);
    assert_eq!(plan.steps[0].id, "s1");
    assert_eq!(plan.steps[1].id, "s2");
}

#[tokio::test]
async fn diagnose_alias_from_legacy_debug_string() {
    assert_eq!(
        InteractionMode::parse("debug"),
        Some(InteractionMode::Diagnose)
    );
    assert_eq!(InteractionMode::Diagnose.as_str(), "diagnose");
    let _ = AgentPlanStep {
        id: "x".into(),
        title: "t".into(),
        status: PlanStepStatus::Done,
        note: None,
    };
    let _ = StaticIdentityLoader;
}
