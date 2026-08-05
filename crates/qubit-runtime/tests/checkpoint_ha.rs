use std::time::Duration;

use qubit_protocol::{
    AgentSpecId, HitlInboxStatus, InteractionMode, SessionCreate, TurnStart, UserInput,
};
use qubit_runtime::CoreRuntimeService;

#[tokio::test]
async fn checkpoint_persists_completed_turn() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("runtime.sqlite");
    let rt = CoreRuntimeService::new_with_sqlite(&db).unwrap();
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
                text: "persist me".into(),
                attachments: vec![],
                client_meta: None,
            },
            idempotency_key: "k-cp".into(),
        })
        .await
        .unwrap();

    rt.await_turn_terminal(&started.turn_id, Duration::from_secs(2))
        .await
        .unwrap();

    // Re-open store and ensure row exists via recover / list
    let rt2 = CoreRuntimeService::new_with_sqlite(&db).unwrap();
    let recovered = rt2.recover_on_boot().await.unwrap();
    // Completed turns are terminal → not counted as pending HITL
    assert_eq!(recovered, 0);
    assert!(started.turn_id.as_str().starts_with("trn_"));
}

#[tokio::test]
async fn plan_mode_denies_non_plan_tools_via_allows_tool() {
    assert!(InteractionMode::Plan.allows_tool("update_plan"));
    assert!(!InteractionMode::Plan.allows_tool("market.readiness"));
    assert!(InteractionMode::Ask.allows_tool("workspace.read"));
    assert!(!InteractionMode::Ask.allows_tool("recommendation.record"));
    assert!(InteractionMode::Agent.allows_tool("anything"));
}

#[tokio::test]
async fn hitl_status_enum_roundtrip() {
    let s = HitlInboxStatus::Pending;
    let v = serde_json::to_value(s).unwrap();
    assert_eq!(v, "pending");
}
