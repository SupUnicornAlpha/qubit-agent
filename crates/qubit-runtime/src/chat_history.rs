//! Chat history invariants for OpenAI/DeepSeek tool rounds.

use serde_json::Value;

/// After an assistant `tool_calls` message, only `role=tool` replies may appear until
/// every `tool_call_id` is satisfied. Non-tool messages (system nudges) must wait.
pub fn tool_round_is_well_formed(history: &[Value]) -> bool {
    let mut i = 0;
    while i < history.len() {
        let role = history[i].get("role").and_then(|v| v.as_str()).unwrap_or("");
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
            let r = history[j].get("role").and_then(|v| v.as_str()).unwrap_or("");
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
}
