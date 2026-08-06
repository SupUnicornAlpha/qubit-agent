//! Multi-provider hidden-reasoning extraction for OpenAI-compatible (and adjacent) payloads.
//!
//! Sources (non-exhaustive):
//! - DeepSeek / Qwen / GLM / many OpenAI-compat proxies: `reasoning_content`
//! - OpenRouter / some gateways: `reasoning`, `reasoning_details[]`
//! - Anthropic Messages (or Anthropic-compat proxies): content blocks `thinking` / `redacted_thinking`
//! - OpenAI Responses-shaped fragments embedded in message: `reasoning` / summary text
//! - Gemini-style parts: `{ "thought": true, "text": "..." }`
//!
//! Extracted text is for UI ghost frames only — never merge into answer `content`.

use serde_json::Value;

/// Pull hidden reasoning from a chat-completions `message` object (or similar).
pub fn extract_reasoning_from_message(message: &Value) -> Option<String> {
    if !message.is_object() {
        return None;
    }

    let mut parts: Vec<String> = Vec::new();

    push_str_field(message, "reasoning_content", &mut parts);
    push_str_field(message, "reasoning", &mut parts);
    push_str_field(message, "thinking", &mut parts);
    push_str_field(message, "reasoning_text", &mut parts);
    push_str_field(message, "thought", &mut parts);

    if let Some(details) = message.get("reasoning_details") {
        collect_reasoning_details(details, &mut parts);
    }
    if let Some(summary) = message.get("reasoning_summary") {
        collect_reasoning_summary(summary, &mut parts);
    }

    // Anthropic / Gemini-style content arrays (when proxies reuse chat.completions shape)
    if let Some(content) = message.get("content") {
        collect_from_content_value(content, &mut parts);
    }

    let joined = join_unique(parts);
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// Extract from a full chat.completions response (choices[0].message + optional root fields).
pub fn extract_reasoning_from_chat_completion(root: &Value) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some(message) = root
        .pointer("/choices/0/message")
        .or_else(|| root.pointer("/choices/0/delta"))
    {
        if let Some(t) = extract_reasoning_from_message(message) {
            parts.push(t);
        }
    }
    // Some gateways put reasoning beside the choice
    if let Some(choice) = root.pointer("/choices/0") {
        push_str_field(choice, "reasoning_content", &mut parts);
        push_str_field(choice, "reasoning", &mut parts);
    }
    let joined = join_unique(parts);
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

/// Rough token estimate when upstream omits reasoning_tokens (chars/4).
pub fn estimate_reasoning_tokens(chars: usize) -> u32 {
    if chars == 0 {
        0
    } else {
        ((chars + 3) / 4) as u32
    }
}

/// Split long reasoning into pseudo-stream chunks for SSE UI.
pub fn chunk_reasoning_for_stream(text: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(1);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    let mut buf = String::new();
    for ch in trimmed.chars() {
        buf.push(ch);
        if buf.chars().count() >= max_chars {
            out.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn push_str_field(obj: &Value, key: &str, parts: &mut Vec<String>) {
    if let Some(Value::String(s)) = obj.get(key) {
        let t = s.trim();
        if !t.is_empty() {
            parts.push(t.to_string());
        }
    }
}

fn collect_reasoning_details(details: &Value, parts: &mut Vec<String>) {
    match details {
        Value::String(s) => {
            let t = s.trim();
            if !t.is_empty() {
                parts.push(t.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                if let Some(s) = item.as_str() {
                    let t = s.trim();
                    if !t.is_empty() {
                        parts.push(t.to_string());
                    }
                    continue;
                }
                push_str_field(item, "text", parts);
                push_str_field(item, "content", parts);
                push_str_field(item, "reasoning", parts);
                push_str_field(item, "summary", parts);
            }
        }
        Value::Object(_) => {
            push_str_field(details, "text", parts);
            push_str_field(details, "content", parts);
            push_str_field(details, "summary", parts);
        }
        _ => {}
    }
}

fn collect_reasoning_summary(summary: &Value, parts: &mut Vec<String>) {
    match summary {
        Value::String(s) => {
            let t = s.trim();
            if !t.is_empty() {
                parts.push(t.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                push_str_field(item, "text", parts);
                push_str_field(item, "summary", parts);
                if let Some(s) = item.as_str() {
                    let t = s.trim();
                    if !t.is_empty() {
                        parts.push(t.to_string());
                    }
                }
            }
        }
        Value::Object(_) => {
            push_str_field(summary, "text", parts);
            push_str_field(summary, "summary", parts);
        }
        _ => {}
    }
}

fn collect_from_content_value(content: &Value, parts: &mut Vec<String>) {
    match content {
        Value::Array(blocks) => {
            for block in blocks {
                let ty = block
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let is_thought_flag = block
                    .get("thought")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let is_thinking_block = matches!(
                    ty.as_str(),
                    "thinking" | "redacted_thinking" | "reasoning" | "reasoning_content"
                ) || is_thought_flag;
                if !is_thinking_block {
                    continue;
                }
                push_str_field(block, "thinking", parts);
                push_str_field(block, "text", parts);
                push_str_field(block, "content", parts);
                push_str_field(block, "reasoning", parts);
                // Anthropic sometimes nests data
                if let Some(data) = block.get("data") {
                    push_str_field(data, "text", parts);
                }
            }
        }
        // String content is answer body — do not treat as reasoning.
        _ => {}
    }
}

fn join_unique(parts: Vec<String>) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for p in parts {
        let key = p.trim().to_string();
        if key.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        out.push(key);
    }
    out.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deepseek_reasoning_content() {
        let msg = json!({
            "role": "assistant",
            "content": "结论",
            "reasoning_content": "先分析再下结论"
        });
        assert_eq!(
            extract_reasoning_from_message(&msg).as_deref(),
            Some("先分析再下结论")
        );
    }

    #[test]
    fn openrouter_reasoning_details() {
        let msg = json!({
            "content": "ok",
            "reasoning": "top-level",
            "reasoning_details": [
                { "type": "reasoning.summary", "summary": "detail-a" },
                { "text": "detail-b" }
            ]
        });
        let got = extract_reasoning_from_message(&msg).unwrap();
        assert!(got.contains("top-level"));
        assert!(got.contains("detail-a"));
        assert!(got.contains("detail-b"));
    }

    #[test]
    fn anthropic_thinking_blocks() {
        let msg = json!({
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "内部推理" },
                { "type": "text", "text": "对用户可见" }
            ]
        });
        assert_eq!(
            extract_reasoning_from_message(&msg).as_deref(),
            Some("内部推理")
        );
    }

    #[test]
    fn gemini_thought_parts() {
        let msg = json!({
            "content": [
                { "thought": true, "text": "chain" },
                { "text": "answer" }
            ]
        });
        assert_eq!(
            extract_reasoning_from_message(&msg).as_deref(),
            Some("chain")
        );
    }

    #[test]
    fn chat_completion_root() {
        let root = json!({
            "choices": [{
                "message": {
                    "content": null,
                    "reasoning_content": "tool 前思考",
                    "tool_calls": []
                }
            }]
        });
        assert_eq!(
            extract_reasoning_from_chat_completion(&root).as_deref(),
            Some("tool 前思考")
        );
    }

    #[test]
    fn plain_content_is_not_reasoning() {
        let msg = json!({ "content": "只是正文" });
        assert_eq!(extract_reasoning_from_message(&msg), None);
    }

    #[test]
    fn chunks_reasoning() {
        let chunks = chunk_reasoning_for_stream("abcdefghij", 4);
        assert_eq!(chunks, vec!["abcd", "efgh", "ij"]);
    }
}
