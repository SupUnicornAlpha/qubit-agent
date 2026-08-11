//! Chat history invariants for OpenAI/DeepSeek tool rounds + observation prune (P2).

use serde_json::{json, Value};

/// Truncate a single tool observation string (char-budget, UTF-8 safe).
pub fn truncate_observation(content: &str, max_chars: usize) -> String {
    if max_chars == 0 || content.chars().count() <= max_chars {
        return content.to_string();
    }
    let keep = max_chars.saturating_sub(24);
    let prefix: String = content.chars().take(keep).collect();
    format!(
        "{prefix}…[truncated {}→{} chars]",
        content.chars().count(),
        max_chars
    )
}

/// Stub older tool observations while protecting the newest `protect_chars` of tool content.
///
/// Mirrors OpenCode PRUNE_PROTECT: keep recent tool payloads intact for the live turn,
/// replace older ones with short stubs so context does not thrash on huge dumps.
/// Does not reorder messages (tool-round shape stays valid).
pub fn prune_tool_observations(history: &mut [Value], protect_chars: usize) {
    if protect_chars == 0 || history.is_empty() {
        return;
    }

    let tool_idxs: Vec<usize> = history
        .iter()
        .enumerate()
        .filter(|(_, m)| m.get("role").and_then(|v| v.as_str()) == Some("tool"))
        .map(|(i, _)| i)
        .collect();
    if tool_idxs.is_empty() {
        return;
    }

    let mut protected = 0usize;
    let mut keep_from_end = 0usize;
    for &idx in tool_idxs.iter().rev() {
        let len = history[idx]
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.chars().count())
            .unwrap_or(0);
        if protected > 0 && protected + len > protect_chars {
            break;
        }
        protected = protected.saturating_add(len);
        keep_from_end += 1;
        if protected >= protect_chars {
            break;
        }
    }

    let prune_until = tool_idxs.len().saturating_sub(keep_from_end);
    for &idx in tool_idxs.iter().take(prune_until) {
        let Some(content) = history[idx].get("content").and_then(|v| v.as_str()) else {
            continue;
        };
        if content.starts_with("[pruned_observation") {
            continue;
        }
        let chars = content.chars().count();
        if chars <= 160 {
            continue;
        }
        let call_id = history[idx]
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .unwrap_or("?");
        let stub = format!(
            "[pruned_observation chars={chars} tool_call_id={call_id}] full payload omitted; use fresher tools or refs"
        );
        if let Some(obj) = history[idx].as_object_mut() {
            obj.insert("content".into(), json!(stub));
        }
    }
}

/// After an assistant `tool_calls` message, only `role=tool` replies may appear until
/// every `tool_call_id` is satisfied. Non-tool messages (system nudges) must wait.
pub fn tool_round_is_well_formed(history: &[Value]) -> bool {
    let mut i = 0;
    while i < history.len() {
        let role = history[i]
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if role != "assistant" {
            i += 1;
            continue;
        }
        let Some(calls) = history[i].get("tool_calls").and_then(|v| v.as_array()) else {
            i += 1;
            continue;
        };
        if calls.is_empty() {
            i += 1;
            continue;
        }
        let expected: Vec<&str> = calls
            .iter()
            .filter_map(|c| c.get("id").and_then(|v| v.as_str()))
            .collect();
        let mut seen = 0usize;
        let mut j = i + 1;
        while j < history.len() {
            let r = history[j]
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if r != "tool" {
                break;
            }
            let id = history[j]
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if !expected.iter().any(|e| *e == id) {
                return false;
            }
            seen += 1;
            j += 1;
        }
        if seen != expected.len() {
            return false;
        }
        i = j;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_system_nudge_between_tool_replies() {
        let history = vec![
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {"id": "a", "type": "function", "function": {"name": "t", "arguments": "{}"}},
                    {"id": "b", "type": "function", "function": {"name": "t", "arguments": "{}"}}
                ]
            }),
            json!({"role": "tool", "tool_call_id": "a", "content": "{}"}),
            json!({"role": "system", "content": "STALL_BUDGET"}),
            json!({"role": "tool", "tool_call_id": "b", "content": "{}"}),
        ];
        assert!(!tool_round_is_well_formed(&history));
    }

    #[test]
    fn accepts_nudge_after_full_tool_block() {
        let history = vec![
            json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {"id": "a", "type": "function", "function": {"name": "t", "arguments": "{}"}},
                    {"id": "b", "type": "function", "function": {"name": "t", "arguments": "{}"}}
                ]
            }),
            json!({"role": "tool", "tool_call_id": "a", "content": "{}"}),
            json!({"role": "tool", "tool_call_id": "b", "content": "{}"}),
            json!({"role": "system", "content": "STALL_BUDGET"}),
        ];
        assert!(tool_round_is_well_formed(&history));
    }

    #[test]
    fn truncate_observation_respects_char_budget() {
        let s = "x".repeat(100);
        let out = truncate_observation(&s, 40);
        assert!(out.chars().count() <= 50);
        assert!(out.contains("truncated"));
    }

    #[test]
    fn prune_keeps_recent_tool_payloads() {
        let big = "B".repeat(500);
        let mut history = vec![
            json!({"role": "tool", "tool_call_id": "old", "content": big}),
            json!({"role": "tool", "tool_call_id": "new", "content": "fresh-result"}),
        ];
        prune_tool_observations(&mut history, 100);
        let old = history[0]["content"].as_str().unwrap();
        let new = history[1]["content"].as_str().unwrap();
        assert!(old.starts_with("[pruned_observation"));
        assert_eq!(new, "fresh-result");
        assert!(tool_round_is_well_formed(&history));
    }
}
