//! Soak / kill-9 style recovery: abort mid-turn, reopen SQLite checkpoint.

use std::sync::Arc;
use std::time::Duration;

use qubit_protocol::{
    AgentSpecId, InteractionMode, SessionCreate, TurnStart, TurnState, UserInput,
};
use qubit_runtime::{
    CancellableSlowModel, CheckpointStore, CoreRuntimeService, SqliteCheckpointStore,
};

#[tokio::test]
async fn kill9_mid_turn_leaves_non_terminal_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("soak.sqlite");

    let model = Arc::new(CancellableSlowModel {
        delay_ms: 800,
        polls: 40,
    });
    let rt = CoreRuntimeService::new_with_sqlite_and_model(&db, model).unwrap();
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
        .start_turn_abortable(TurnStart {
            session_id: session.session_id.clone(),
            input: UserInput {
                text: "soak".into(),
                attachments: vec![],
                client_meta: None,
            },
            idempotency_key: "soak-1".into(),
        })
        .await
        .unwrap();

    // Let Preparing/Reasoning checkpoint land.
    tokio::time::sleep(Duration::from_millis(80)).await;

    // Simulate kill -9: abort the turn task hard.
    started.abort.abort();
    tokio::time::sleep(Duration::from_millis(30)).await;
    drop(rt);

    let cp2 = SqliteCheckpointStore::open(&db).unwrap();
    let non_term = cp2.list_non_terminal().await.unwrap();
    assert!(
        !non_term.is_empty(),
        "expected non-terminal checkpoint after kill-9"
    );
    assert!(non_term.iter().any(|r| r.turn_id == started.turn_id));
    assert!(non_term.iter().any(|r| {
        !matches!(
            r.state,
            TurnState::Completed | TurnState::Cancelled | TurnState::Failed
        )
    }));

    let rt2 = CoreRuntimeService::new_with_sqlite(&db).unwrap();
    let _ = rt2.recover_on_boot().await.unwrap();
}
