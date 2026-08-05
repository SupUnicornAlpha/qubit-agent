use qubit_protocol::{
    AgentSpecId, DeliveryStatus, ExecutionKind, InteractionMode, InvocationBudget, InvocationId,
    InvocationRequest, InvocationState, SessionCreate, TurnId, WorkspaceId,
};
use qubit_runtime::CoreRuntimeService;

#[tokio::test]
async fn invoke_subagent_isolated_session() {
    let rt = CoreRuntimeService::new_for_test();
    rt.seed_defaults().await;

    let parent = rt
        .create_session(SessionCreate {
            workspace_id: Some(WorkspaceId::new("ws_inv")),
            agent_ref: AgentSpecId::new("def-primary"),
            interaction_mode: InteractionMode::Agent,
            mode: None,
        })
        .await
        .unwrap();

    // Parent turn id is required by InvocationRequest; invent one for admission path.
    let rec = rt
        .invoke_agent(InvocationRequest {
            invocation_id: InvocationId::new("inv_test1"),
            parent_session_id: parent.session_id.clone(),
            parent_turn_id: TurnId::new("trn_parent"),
            caller_instance_id: parent.agent_instance_id.clone(),
            callee_spec_id: AgentSpecId::new("def-research-sub"),
            goal: "analyze AAPL briefly".into(),
            handoff_in: None,
            deadline_ms: None,
            budget: InvocationBudget {
                max_iterations: 2,
                max_tokens: None,
                tool_surface_override: None,
            },
        })
        .await
        .expect("invoke");

    assert_eq!(rec.state, InvocationState::Completed);
    assert_ne!(rec.child_session_id, parent.session_id);
    let child = rt.store().get_session(&rec.child_session_id).await.unwrap();
    assert_eq!(child.view.execution_kind, ExecutionKind::Subagent);
    assert!(rec.handoff_out.is_some());
    assert!(rec.delivery.is_some());
    assert_eq!(
        rec.delivery.as_ref().unwrap().status,
        DeliveryStatus::Delivered
    );
}

#[tokio::test]
async fn invoke_rejects_user_path_subagent_still() {
    let rt = CoreRuntimeService::new_for_test();
    rt.seed_defaults().await;
    let err = rt
        .create_session(SessionCreate {
            workspace_id: None,
            agent_ref: AgentSpecId::new("def-research-sub"),
            interaction_mode: InteractionMode::Agent,
            mode: None,
        })
        .await;
    assert!(err.is_err());
}
