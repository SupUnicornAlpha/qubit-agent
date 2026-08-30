//! Deterministic, per-agent tool surface resolution.
//!
//! The bridge knows more tools than any one agent should see. Resolving the
//! surface before context assembly keeps the names in the prompt and the
//! function schemas sent to the provider in exact lockstep.

use std::collections::BTreeSet;

const L0_TOOLS: &[&str] = &["update_plan", "agent.invoke"];

fn bare(name: &str) -> &str {
    name.strip_prefix("tool/").unwrap_or(name)
}

fn matches_name(candidate: &str, configured: &str) -> bool {
    candidate == configured || bare(candidate) == bare(configured)
}

pub fn resolve_tool_surface(
    available: Vec<String>,
    configured: &[String],
    policy_allowlist: &[String],
    strip_bootstrap_memory_tools: bool,
) -> Vec<String> {
    let allow_mcp = policy_allowlist
        .iter()
        .any(|name| name == "call_mcp" || name.starts_with("mcp:"));

    let mut selected: Vec<String> = available
        .into_iter()
        .filter(|name| bare(name) != "call_mcp")
        .filter(|name| {
            configured.is_empty()
                || L0_TOOLS.iter().any(|tool| bare(name) == *tool)
                || configured.iter().any(|allowed| matches_name(name, allowed))
        })
        .filter(|name| {
            policy_allowlist.is_empty()
                || L0_TOOLS.iter().any(|tool| bare(name) == *tool)
                || (allow_mcp && bare(name).starts_with("mcp:"))
                || policy_allowlist
                    .iter()
                    .any(|allowed| matches_name(name, allowed))
        })
        .filter(|name| {
            !strip_bootstrap_memory_tools
                || !matches!(
                    bare(name),
                    "memory.recall" | "workspace.memory.search" | "workspace.context.snapshot"
                )
        })
        .collect();

    // BTreeSet gives a stable order and removes bridge/fallback duplicates.
    selected.sort();
    selected.dedup();
    selected
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::resolve_tool_surface;

    #[test]
    fn configured_surface_is_a_strict_subset_of_bridge() {
        let out = resolve_tool_surface(
            vec![
                "update_plan".into(),
                "agent.invoke".into(),
                "market.snapshot.get".into(),
                "backtest.run".into(),
                "web.search".into(),
            ],
            &["market.snapshot.get".into(), "web.search".into()],
            &[],
            false,
        );
        assert_eq!(
            out,
            vec![
                "agent.invoke",
                "market.snapshot.get",
                "update_plan",
                "web.search"
            ]
        );
    }

    #[test]
    fn policy_and_bootstrap_filters_apply_before_advertisement() {
        let out = resolve_tool_surface(
            vec![
                "update_plan".into(),
                "agent.invoke".into(),
                "memory.recall".into(),
                "market.snapshot.get".into(),
                "web.search".into(),
                "call_mcp".into(),
            ],
            &[],
            &["market.snapshot.get".into()],
            true,
        );
        assert_eq!(
            out,
            vec!["agent.invoke", "market.snapshot.get", "update_plan"]
        );
    }
}
