use qubit_protocol::{
    AgentSpecId, ExecutionKind, TriggerEvent, TriggerEventId, TriggerSpec, WorkspaceId,
};
use qubit_runtime::CoreRuntimeService;
use serde_json::json;

#[tokio::test]
async fn trigger_ingest_wakes_reactor() {
    let rt = CoreRuntimeService::new_for_test();
    rt.seed_defaults().await;

    let turn = rt
        .ingest_trigger(TriggerEvent {
            event_id: TriggerEventId::new("evt_news_1"),
            source: TriggerSpec::DomainEvent {
                event_name: "market.news".into(),
            },
            payload: json!({ "headline": "Fed holds rates" }),
            workspace_id: Some(WorkspaceId::new("ws_trig")),
            target_spec_id: None,
            correlation_id: Some("corr-1".into()),
        })
        .await
        .expect("ingest")
        .expect("turn_id");

    assert!(turn.starts_with("trn_"));

    // Idempotent replay
    let again = rt
        .ingest_trigger(TriggerEvent {
            event_id: TriggerEventId::new("evt_news_1"),
            source: TriggerSpec::DomainEvent {
                event_name: "market.news".into(),
            },
            payload: json!({ "headline": "ignored" }),
            workspace_id: Some(WorkspaceId::new("ws_trig")),
            target_spec_id: None,
            correlation_id: None,
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again, turn);
}

#[tokio::test]
async fn trigger_with_explicit_target() {
    let rt = CoreRuntimeService::new_for_test();
    rt.seed_defaults().await;

    let turn = rt
        .ingest_trigger(TriggerEvent {
            event_id: TriggerEventId::new("evt_news_2"),
            source: TriggerSpec::DomainEvent {
                event_name: "market.news".into(),
            },
            payload: json!({}),
            workspace_id: None,
            target_spec_id: Some(AgentSpecId::new("def-news-reactor")),
            correlation_id: None,
        })
        .await
        .unwrap()
        .unwrap();
    assert!(turn.starts_with("trn_"));
}

#[tokio::test]
async fn primary_cannot_accept_trigger() {
    let rt = CoreRuntimeService::new_for_test();
    rt.seed_defaults().await;
    let err = rt
        .ingest_trigger(TriggerEvent {
            event_id: TriggerEventId::new("evt_bad"),
            source: TriggerSpec::DomainEvent {
                event_name: "market.news".into(),
            },
            payload: json!({}),
            workspace_id: None,
            target_spec_id: Some(AgentSpecId::new("def-primary")),
            correlation_id: None,
        })
        .await;
    assert!(err.is_err());
}

#[tokio::test]
async fn reactor_not_user_session() {
    let rt = CoreRuntimeService::new_for_test();
    rt.seed_defaults().await;
    let specs = rt.list_agents().await.agents;
    let reactor = specs
        .iter()
        .find(|s| s.id.as_str() == "def-news-reactor")
        .unwrap();
    assert_eq!(reactor.execution_kind, ExecutionKind::Reactor);
}
