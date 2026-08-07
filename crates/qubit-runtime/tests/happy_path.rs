use std::time::Duration;

use qubit_protocol::{
    AgentSpec, AgentSpecId, DeliveryStatus, ExecutionKind, InteractionMode, Lifecycle,
    RuntimeEvent, SessionCreate, TurnCancel, TurnStart, UserInput, WorkspaceId,
};
use qubit_runtime::{
    AgentAdmission, CancellableSlowModel, CoreRuntimeService, DefaultAdmission, RuntimeLimits,
};

#[tokio::test]
async fn happy_path_primary_turn() {
    let rt = CoreRuntimeService::new_for_test();
    rt.seed_defaults().await;

    let session = rt
        .create_session(SessionCreate {
            workspace_id: Some(WorkspaceId::new("ws_test")),
            agent_ref: AgentSpecId::new("def-primary"),
            interaction_mode: InteractionMode::Agent,
            mode: Some("chat".into()),
        })
        .await
        .expect("create session");

    assert_eq!(session.execution_kind, ExecutionKind::Primary);
    assert_eq!(session.interaction_mode, InteractionMode::Agent);

    let started = rt
        .start_turn(TurnStart {
            session_id: session.session_id.clone(),
            input: UserInput {
                text: "hello prime".into(),
                attachments: vec![],
                client_meta: None,
            },
            idempotency_key: "k1".into(),
            context: None,
        })
        .await
        .expect("start turn");

    assert!(started.turn_id.as_str().starts_with("trn_"));

    let done = rt
        .await_turn_terminal(&started.turn_id, Duration::from_secs(2))
        .await
        .expect("await terminal");
    match done {
        RuntimeEvent::TurnCompleted {
            lifecycle,
            delivery,
            ..
        } => {
            assert_eq!(lifecycle, Lifecycle::Completed);
            assert_eq!(delivery.status, DeliveryStatus::Delivered);
        }
        other => panic!("unexpected {other:?}"),
    }

    let health = rt.health().await;
    assert_eq!(health.core_backend, "rust");
    // FakeModelClient marks health degraded — expected in unit tests without LLM.
    assert!(
        health.status == "ok"
            || health
                .degraded_reasons
                .iter()
                .any(|r| r == "fake_model"),
        "unexpected health: {:?}",
        health.degraded_reasons
    );
}

#[tokio::test]
async fn subagent_rejected_for_user_session() {
    let rt = CoreRuntimeService::new_for_test();
    let sub = AgentSpec {
        id: AgentSpecId::new("def-sub"),
        version: "0.1.0".into(),
        display_name: "Sub".into(),
        execution_kind: ExecutionKind::Subagent,
        labels: vec!["research".into()],
        identity_prompt_ref: "prompts/sub.md".into(),
        system_prompt: None,
        default_recipe_id: None,
        tool_surface_ref: "surfaces/sub".into(),
        model_ref: None,
        max_iterations: 4,
        hitl_profile_ref: None,
        allowed_callers: vec![],
        triggers: vec![],
        enabled: true,
    };
    rt.upsert_agent_spec(sub.clone()).await;

    let err = rt
        .create_session(SessionCreate {
            workspace_id: None,
            agent_ref: AgentSpecId::new("def-sub"),
            interaction_mode: InteractionMode::Agent,
            mode: None,
        })
        .await;
    assert!(err.is_err());

    let admission = DefaultAdmission;
    assert!(admission.admit_user_turn(&sub).is_err());
}

#[tokio::test]
async fn plan_mode_session_resolves_from_legacy_string() {
    let rt = CoreRuntimeService::new_for_test();
    rt.seed_defaults().await;
    let session = rt
        .create_session(SessionCreate {
            workspace_id: None,
            agent_ref: AgentSpecId::new("def-primary"),
            interaction_mode: InteractionMode::Agent,
            mode: Some("plan".into()),
        })
        .await
        .unwrap();
    assert_eq!(session.interaction_mode, InteractionMode::Plan);
}

#[tokio::test]
async fn cancel_inflight_turn() {
    let model = std::sync::Arc::new(CancellableSlowModel {
        delay_ms: 500,
        polls: 50,
    });
    let rt = CoreRuntimeService::new_with_model(model);
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
                text: "slow".into(),
                attachments: vec![],
                client_meta: None,
            },
            idempotency_key: "k-cancel".into(),
            context: None,
        })
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(30)).await;
    rt.cancel_turn(TurnCancel {
        session_id: session.session_id.clone(),
        turn_id: started.turn_id.clone(),
    })
    .await
    .unwrap();

    let done = rt
        .await_turn_terminal(&started.turn_id, Duration::from_secs(2))
        .await
        .unwrap();
    match done {
        RuntimeEvent::TurnCompleted {
            lifecycle,
            delivery,
            ..
        } => {
            assert_eq!(lifecycle, Lifecycle::Cancelled);
            assert_eq!(delivery.status, DeliveryStatus::Cancelled);
        }
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn supervisor_rejects_when_saturated() {
    let model = std::sync::Arc::new(CancellableSlowModel {
        delay_ms: 300,
        polls: 30,
    });
    let rt = CoreRuntimeService::new_with_model_and_limits(
        model,
        RuntimeLimits {
            max_concurrent_turns: 1,
            event_bus_capacity: 64,
        },
    );
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

    let _first = rt
        .start_turn(TurnStart {
            session_id: session.session_id.clone(),
            input: UserInput {
                text: "hold".into(),
                attachments: vec![],
                client_meta: None,
            },
            idempotency_key: "k-sat-1".into(),
            context: None,
        })
        .await
        .unwrap();

    tokio::time::sleep(Duration::from_millis(20)).await;
    let err = rt
        .start_turn(TurnStart {
            session_id: session.session_id.clone(),
            input: UserInput {
                text: "overflow".into(),
                attachments: vec![],
                client_meta: None,
            },
            idempotency_key: "k-sat-2".into(),
            context: None,
        })
        .await;
    assert!(err.is_err(), "expected saturated");
}
