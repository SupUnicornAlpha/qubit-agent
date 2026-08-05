//! Session + HITL survive Core process restart (05 · C2 / S5).

use qubit_protocol::{
    AgentInstanceId, AgentSpecId, ExecutionKind, HitlChannelHint, HitlInboxFilter, HitlInboxId,
    HitlInboxItem, HitlInboxStatus, HitlInputKind, HitlPrompt, HitlPromptId, HitlRespond,
    HitlSource, InteractionMode, SessionCreate, SessionGet, SessionId, TurnId, WorkspaceId,
};
use qubit_runtime::{CoreDb, CoreRuntimeService, HitlInbox, SqliteHitlInbox};
use std::sync::Arc;

#[tokio::test]
async fn session_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("runtime.sqlite");

    let session_id = {
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
        session.session_id
    };

    let rt2 = CoreRuntimeService::new_with_sqlite(&db).unwrap();
    rt2.recover_on_boot().await.unwrap();
    let view = rt2
        .get_session(SessionGet {
            session_id: session_id.clone(),
        })
        .await
        .expect("session must survive reopen");
    assert_eq!(view.session_id, session_id);
    assert_eq!(view.agent_spec_id.as_str(), "def-primary");
}

#[tokio::test]
async fn hitl_pending_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("runtime.sqlite");

    // Ensure schema exists via first open.
    {
        let rt = CoreRuntimeService::new_with_sqlite(&db).unwrap();
        rt.seed_defaults().await;
    }

    let inbox_id = HitlInboxId::new("inbox_persist_1");
    {
        let db_conn = Arc::new(CoreDb::open(&db).unwrap());
        let inbox = SqliteHitlInbox::new(db_conn);
        let item = HitlInboxItem {
            inbox_id: inbox_id.clone(),
            prompt: HitlPrompt {
                id: HitlPromptId::new("hitl_persist_1"),
                turn_id: TurnId::new("trn_placeholder"),
                input_kind: HitlInputKind::ApproveOnly,
                title: "Approve?".into(),
                body: "test".into(),
                options: vec![],
                hard_rule: false,
                created_at: 1,
            },
            workspace_id: WorkspaceId::new("ws_test"),
            session_id: SessionId::new("ses_placeholder"),
            turn_id: TurnId::new("trn_placeholder"),
            agent_instance_id: AgentInstanceId::new("inst_placeholder"),
            execution_kind: ExecutionKind::Primary,
            source: HitlSource::UserTurn,
            status: HitlInboxStatus::Pending,
            created_at_ms: 1,
            expires_at_ms: None,
            channel_hints: vec![HitlChannelHint::IdePanel],
        };
        inbox.enqueue(item).await.unwrap();
    }

    let rt2 = CoreRuntimeService::new_with_sqlite(&db).unwrap();
    rt2.recover_on_boot().await.unwrap();
    let pending = rt2
        .list_hitl_inbox(HitlInboxFilter {
            pending_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(
        pending.iter().any(|i| i.inbox_id == inbox_id),
        "pending HITL must survive reopen"
    );

    rt2.respond_hitl(HitlRespond {
        inbox_id: inbox_id.clone(),
        approved: true,
        selected_option_ids: None,
        free_form: None,
        client_meta: None,
    })
    .await
    .unwrap();

    let rt3 = CoreRuntimeService::new_with_sqlite(&db).unwrap();
    rt3.recover_on_boot().await.unwrap();
    let still = rt3
        .list_hitl_inbox(HitlInboxFilter {
            pending_only: true,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(!still.iter().any(|i| i.inbox_id == inbox_id));
}
