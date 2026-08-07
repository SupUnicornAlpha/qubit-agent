use qubit_protocol::{
    default_slot_budgets, system_slot_order, user_slot_order, AgentSpec, AgentSpecId,
    CallerSelector, DeliveryStatus, DeliveryVerdict, ExecutionKind, SessionCreate, TurnStart,
    UserInput, FINANCE_SUB_KINDS, PROTOCOL_VERSION,
};

#[test]
fn protocol_version_is_set() {
    assert!(!PROTOCOL_VERSION.is_empty());
}

#[test]
fn agent_spec_roundtrip_json() {
    let spec = AgentSpec {
        id: AgentSpecId::new("def-orchestrator"),
        version: "1.0.0".into(),
        display_name: "编排器".into(),
        execution_kind: ExecutionKind::Primary,
        labels: vec!["orchestrator".into()],
        identity_prompt_ref: "prompts/orchestrator.md".into(),
        system_prompt: None,
        default_recipe_id: Some("research".into()),
        tool_surface_ref: "surfaces/primary".into(),
        model_ref: None,
        max_iterations: 10,
        hitl_profile_ref: Some("hitl/default".into()),
        allowed_callers: vec![CallerSelector::ExecutionKind {
            execution_kind: ExecutionKind::Primary,
        }],
        triggers: vec![],
        enabled: true,
    };

    let json = serde_json::to_string(&spec).unwrap();
    let back: AgentSpec = serde_json::from_str(&json).unwrap();
    assert_eq!(back.execution_kind, ExecutionKind::Primary);
    assert_eq!(back.id.as_str(), "def-orchestrator");
    assert!(json.contains("\"primary\""));
}

#[test]
fn execution_kind_wire_names() {
    assert_eq!(
        serde_json::to_value(ExecutionKind::Subagent).unwrap(),
        serde_json::json!("subagent")
    );
    assert_eq!(
        serde_json::to_value(ExecutionKind::Reactor).unwrap(),
        serde_json::json!("reactor")
    );
}

#[test]
fn turn_start_roundtrip() {
    let req = TurnStart {
        session_id: qubit_protocol::SessionId::new("ses_1"),
        input: UserInput {
            text: "分析茅台".into(),
            attachments: vec![],
            client_meta: None,
        },
        idempotency_key: "idem-1".into(),
            context: None,
    };
    let json = serde_json::to_string(&req).unwrap();
    let back: TurnStart = serde_json::from_str(&json).unwrap();
    assert_eq!(back.input.text, "分析茅台");
}

#[test]
fn session_create_requires_primary_ref_shape() {
    let req = SessionCreate {
        workspace_id: None,
        agent_ref: AgentSpecId::new("def-orchestrator"),
        interaction_mode: Default::default(),
        mode: Some("chat".into()),
    };
    let v = serde_json::to_value(req).unwrap();
    assert_eq!(v["agent_ref"], "def-orchestrator");
    assert_eq!(
        SessionCreate {
            workspace_id: None,
            agent_ref: AgentSpecId::new("x"),
            interaction_mode: Default::default(),
            mode: Some("plan".into()),
        }
        .resolved_interaction_mode(),
        qubit_protocol::InteractionMode::Plan
    );
}

#[test]
fn delivery_verdict_partial() {
    let v = DeliveryVerdict {
        status: DeliveryStatus::Partial,
        reasons: vec!["missing_artifact:recommendation".into()],
    };
    let json = serde_json::to_value(&v).unwrap();
    assert_eq!(json["status"], "partial");
}

#[test]
fn context_slot_defaults_match_ts_protocol() {
    let budgets = default_slot_budgets();
    assert_eq!(budgets["recall_finance"].priority, 80);
    assert_eq!(budgets["goal"].max_chars, 2_000);
    assert!(system_slot_order().contains(&"identity"));
    assert_eq!(user_slot_order()[0], "goal");
    assert_eq!(user_slot_order()[2], "recall_finance");
}

#[test]
fn finance_sub_kinds_non_empty() {
    assert!(FINANCE_SUB_KINDS.contains(&"strategy_recipe"));
    assert!(FINANCE_SUB_KINDS.contains(&"research_conclusion"));
}
