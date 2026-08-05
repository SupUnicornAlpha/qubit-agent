use qubit_policy::{builtin_catalog, load_policy_snapshot};

#[test]
fn builtin_stock_pick_snapshot() {
    let cat = builtin_catalog();
    let snap = load_policy_snapshot(&cat, Some("sp")).unwrap();
    assert_eq!(snap.recipe_key.as_deref(), Some("stock_pick"));
    assert!(!snap.snapshot_hash.is_empty());
    assert!(snap.completion.artifacts.len() >= 2);
    assert!(snap
        .completion
        .required_tools
        .iter()
        .any(|t| t.capability == "screener"));
}

#[test]
fn open_recipe_has_empty_completion() {
    let cat = builtin_catalog();
    let snap = load_policy_snapshot(&cat, Some("chat")).unwrap();
    assert_eq!(snap.recipe_key.as_deref(), Some("open"));
    assert!(snap.completion.artifacts.is_empty());
    assert!(snap.completion.required_tools.is_empty());
    // stall_budget.tools must NOT become the advertising allowlist
    assert!(
        snap.tool_allowlist.is_empty(),
        "open recipe must advertise all bridge tools (empty allowlist)"
    );
}

#[test]
fn missing_key_yields_placeholder() {
    let cat = builtin_catalog();
    let snap = load_policy_snapshot(&cat, None).unwrap();
    assert!(snap.recipe_key.is_none());
    assert!(!snap.completion.answer_schema.required_sections.is_empty());
}
