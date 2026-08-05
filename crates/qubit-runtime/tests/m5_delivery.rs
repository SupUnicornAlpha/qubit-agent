use qubit_protocol::{
    DeliveryStatus, EffectKind, EffectLedger, EffectRecord, PolicySnapshot, TurnState, TurnView,
};
use qubit_policy::{builtin_catalog, load_policy_snapshot};
use qubit_runtime::LedgerDeliveryEvaluator;
use qubit_runtime::DeliveryEvaluator;

#[test]
fn open_recipe_delivers_without_artifacts() {
    let cat = builtin_catalog();
    let snap = load_policy_snapshot(&cat, Some("open")).unwrap();
    let eval = LedgerDeliveryEvaluator;
    let turn = TurnView {
        turn_id: qubit_protocol::TurnId::new("trn_1"),
        state: TurnState::Completed,
        iteration: 1,
        lifecycle: None,
        delivery: None,
        answer_text: None,
        llm_stats: None,
    };
    let ledger = EffectLedger {
        answer_text: Some("hello".into()),
        ..Default::default()
    };
    let v = eval.evaluate(&snap, &ledger, &turn);
    assert_eq!(v.status, DeliveryStatus::Delivered);
}

#[test]
fn stock_pick_partial_when_artifacts_missing() {
    let cat = builtin_catalog();
    let snap = load_policy_snapshot(&cat, Some("stock_pick")).unwrap();
    let eval = LedgerDeliveryEvaluator;
    let turn = TurnView {
        turn_id: qubit_protocol::TurnId::new("trn_2"),
        state: TurnState::Completed,
        iteration: 1,
        lifecycle: None,
        delivery: None,
        answer_text: None,
        llm_stats: None,
    };
    let v = eval.evaluate(&snap, &EffectLedger::default(), &turn);
    assert_eq!(v.status, DeliveryStatus::Partial);
    assert!(v.reasons.iter().any(|r| r.starts_with("missing_artifact:")));
}

#[test]
fn stock_pick_research_ok_with_gaps() {
    let cat = builtin_catalog();
    let snap = load_policy_snapshot(&cat, Some("stock_pick")).unwrap();
    let eval = LedgerDeliveryEvaluator;
    let turn = TurnView {
        turn_id: qubit_protocol::TurnId::new("trn_3"),
        state: TurnState::Completed,
        iteration: 1,
        lifecycle: None,
        delivery: None,
        answer_text: None,
        llm_stats: None,
    };
    let mut ledger = EffectLedger::default();
    ledger.record_tool_results(
        "run_screener",
        true,
        [EffectRecord {
            kind: EffectKind::Artifact,
            key: "screener_candidate".into(),
            meta: None,
        }],
    );
    ledger.record_tool_results(
        "fetch_klines",
        true,
        [EffectRecord {
            kind: EffectKind::Other,
            key: "klines".into(),
            meta: None,
        }],
    );
    ledger.record_tool_results(
        "recommendation.record",
        true,
        [EffectRecord {
            kind: EffectKind::Artifact,
            key: "recommendation_snapshot".into(),
            meta: None,
        }],
    );
    ledger.answer_text = Some(
        "## goal\nx\n## evidence\ny\n## decision\nz\n## risks\nr\n## gaps\ng".into(),
    );
    let v = eval.evaluate(&snap, &ledger, &turn);
    // research floors met (1 each) but upgrade min_rows=3 → delivered_with_gaps
    assert_eq!(v.status, DeliveryStatus::DeliveredWithGaps);
    assert!(v.reasons.iter().any(|r| r.starts_with("artifact_underfill:")));
}

#[test]
fn missing_recipe_is_partial() {
    let snap = PolicySnapshot {
        recipe_key: None,
        recipe_version: None,
        snapshot_hash: "x".into(),
        tool_allowlist: vec![],
        completion: Default::default(),
        checklist_prompt: vec![],
        stall: None,
    };
    let eval = LedgerDeliveryEvaluator;
    let turn = TurnView {
        turn_id: qubit_protocol::TurnId::new("trn_4"),
        state: TurnState::Completed,
        iteration: 1,
        lifecycle: None,
        delivery: None,
        answer_text: None,
        llm_stats: None,
    };
    let v = eval.evaluate(&snap, &EffectLedger::default(), &turn);
    assert_eq!(v.status, DeliveryStatus::Partial);
    assert!(v.reasons.iter().any(|r| r == "scenario_recipe_missing"));
}
