//! Stall / fail-circuit helpers for turn tool surface narrowing.

use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// Control tools that often fail with bad args — strip after repeated identical failures.
pub const FAIL_CIRCUIT_TOOLS: &[&str] = &[
    "workspace.context.snapshot",
    "research.thesis.write",
    "research.forecast_book.get",
    "workspace.memory.search",
    "recommendation.record",
    "strategy.create_version",
    "factor.compute",
];

pub const FAIL_CIRCUIT_MAX: u32 = 2;

pub fn bare_tool_name(tool_name: &str) -> &str {
    tool_name.strip_prefix("tool/").unwrap_or(tool_name)
}

/// Unify `call_mcp` + nested args into `mcp:<server>:<tool>` family.
pub fn tool_family(tool_name: &str, args: &Value) -> String {
    let bare = bare_tool_name(tool_name);
    if bare == "call_mcp" {
        let flat = flatten_tool_args(args);
        let server = str_field(&flat, &["serverName", "server_name", "server"])
            .unwrap_or("?")
            .to_ascii_lowercase();
        let tool = str_field(
            &flat,
            &["toolName", "tool_name", "mcpTool", "mcp_tool", "tool"],
        )
        .unwrap_or("?")
        .to_ascii_lowercase();
        return format!("mcp:{server}:{tool}");
    }
    bare.to_string()
}

fn flatten_tool_args(args: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(obj) = args.as_object() else {
        return out;
    };
    for (k, v) in obj {
        out.insert(k.clone(), v.clone());
    }
    for nest_key in ["arguments", "params", "args"] {
        if let Some(nested) = obj.get(nest_key).and_then(|v| v.as_object()) {
            for (k, v) in nested {
                out.entry(k.clone()).or_insert_with(|| v.clone());
            }
        }
    }
    out
}

fn str_field<'a>(obj: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    for k in keys {
        if let Some(s) = obj.get(*k).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

fn normalize_symbol(raw: &str) -> String {
    let mut s = raw.trim().to_ascii_uppercase();
    if s.ends_with(".SS") {
        s = format!("{}.SH", &s[..s.len().saturating_sub(3)]);
    }
    s
}

fn normalize_indicator(raw: &str) -> String {
    raw.trim().to_ascii_lowercase()
}

fn arg_sig_for_family(family: &str, args: &Value) -> String {
    let flat = flatten_tool_args(args);
    let mut parts: BTreeMap<String, String> = BTreeMap::new();

    if let Some(sym) = str_field(
        &flat,
        &["symbol", "ticker", "code", "secu_code", "instrument"],
    ) {
        parts.insert("symbol".into(), normalize_symbol(sym));
    }
    if let Some(ind) = str_field(
        &flat,
        &["indicator", "indicators", "indicator_type", "ta"],
    ) {
        parts.insert("indicator".into(), normalize_indicator(ind));
    }
    if let Some(period) = str_field(&flat, &["period", "interval", "timeframe", "tf"]) {
        parts.insert("period".into(), period.to_ascii_lowercase());
    }
    if let Some(expr) = str_field(&flat, &["expression", "expr", "formula"]) {
        // mathjs / code-like — keep short normalized form
        let compact: String = expr.chars().filter(|c| !c.is_whitespace()).take(80).collect();
        parts.insert("expr".into(), compact.to_ascii_lowercase());
    }
    if let Some(q) = str_field(&flat, &["query", "q", "goal"]) {
        let compact: String = q.chars().take(60).collect();
        parts.insert("query".into(), compact.to_ascii_lowercase());
    }

    // Investor-agent common: start/end dates
    if let Some(start) = str_field(&flat, &["start", "start_date", "from"]) {
        parts.insert("start".into(), start.to_string());
    }
    if let Some(end) = str_field(&flat, &["end", "end_date", "to"]) {
        parts.insert("end".into(), end.to_string());
    }

    if parts.is_empty() {
        // Fallback: stable JSON of flattened keys (sorted) truncated
        let mut keys: Vec<_> = flat.keys().cloned().collect();
        keys.sort();
        let mut slim = Map::new();
        for k in keys.into_iter().take(8) {
            if matches!(
                k.as_str(),
                "serverName"
                    | "server_name"
                    | "toolName"
                    | "tool_name"
                    | "mcpTool"
                    | "mcp_tool"
                    | "arguments"
                    | "params"
                    | "args"
            ) {
                continue;
            }
            if let Some(v) = flat.get(&k) {
                slim.insert(k, v.clone());
            }
        }
        let s = Value::Object(slim).to_string();
        truncate_utf8(&s, 120)
    } else {
        let _ = family; // reserved for family-specific rules
        parts
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("&")
    }
}

/// Byte-budget truncate that never splits a UTF-8 codepoint (Chinese-safe).
fn truncate_utf8(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let keep = max_bytes.saturating_sub(3); // room for …
    let end = s.floor_char_boundary(keep);
    format!("{}…", &s[..end])
}

pub fn stall_fingerprint(tool_name: &str, args: &Value, key: &str) -> String {
    let family = tool_family(tool_name, args);
    match key {
        "tool_fingerprint" => format!("{family}|{}", arg_sig_for_family(&family, args)),
        "tool_market" => format!("{family}|market"),
        _ => family,
    }
}

/// Remove the stalled tool and its dual path (`call_mcp` ↔ `mcp:*`).
pub fn strip_tool_from_surface(tool_names: &mut Vec<String>, tool_name: &str, args: &Value) {
    let family = tool_family(tool_name, args);
    let bare = bare_tool_name(tool_name).to_string();
    tool_names.retain(|n| {
        let b = bare_tool_name(n);
        if b == "call_mcp" && family.starts_with("mcp:") {
            return false;
        }
        if b == family || b == bare {
            return false;
        }
        true
    });
}

pub fn is_fail_circuit_tool(name: &str) -> bool {
    let bare = bare_tool_name(name);
    FAIL_CIRCUIT_TOOLS
        .iter()
        .any(|t| *t == bare || bare.starts_with(&format!("{t}.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn call_mcp_and_direct_share_fingerprint() {
        let a = stall_fingerprint(
            "call_mcp",
            &json!({
                "serverName": "investor-agent",
                "mcpTool": "technical_indicator",
                "arguments": { "symbol": "600519.SS", "indicator": "SMA" }
            }),
            "tool_fingerprint",
        );
        let b = stall_fingerprint(
            "mcp:investor-agent:technical_indicator",
            &json!({ "symbol": "600519.SH", "indicator": "sma" }),
            "tool_fingerprint",
        );
        assert_eq!(a, b);
        assert!(a.contains("symbol=600519.SH"));
        assert!(a.contains("indicator=sma"));
    }

    #[test]
    fn strip_removes_call_mcp_sibling() {
        let mut names = vec![
            "update_plan".into(),
            "call_mcp".into(),
            "mcp:mathjs:evaluate".into(),
            "mcp:investor-agent:technical_indicator".into(),
        ];
        strip_tool_from_surface(
            &mut names,
            "mcp:investor-agent:technical_indicator",
            &json!({ "symbol": "AAPL" }),
        );
        assert!(!names.iter().any(|n| n == "call_mcp"));
        assert!(!names
            .iter()
            .any(|n| n == "mcp:investor-agent:technical_indicator"));
        assert!(names.iter().any(|n| n == "mcp:mathjs:evaluate"));
    }

    #[test]
    fn fail_circuit_tools_match() {
        assert!(is_fail_circuit_tool("research.thesis.write"));
        assert!(is_fail_circuit_tool("workspace.context.snapshot"));
        assert!(is_fail_circuit_tool("recommendation.record"));
        assert!(is_fail_circuit_tool("strategy.create_version"));
        assert!(!is_fail_circuit_tool("mcp:mathjs:evaluate"));
    }

    #[test]
    fn fingerprint_truncates_chinese_utf8_safely() {
        // Regression: byte-slice mid-汉字符 used to panic (stall.rs truncate).
        let goal = format!(
            "{{\"goal\":{{\"text\":\"{}\"}}}}",
            "获取半导体相关标的新闻，并在A股半导体板块中筛选超跌反弹个股".repeat(3)
        );
        let args: Value = serde_json::from_str(&goal).unwrap_or_else(|_| {
            json!({ "goal": { "text": "超跌反弹选股方案说明文字".repeat(20) } })
        });
        let fp = stall_fingerprint("update_plan", &args, "tool_fingerprint");
        assert!(!fp.is_empty());
        assert!(fp.is_char_boundary(fp.len()));
    }

    #[test]
    fn truncate_utf8_does_not_split_codepoints() {
        let s = r#"{"goal":{"text":"筛选A股半导体超跌反弹个股"}}"#;
        let out = truncate_utf8(s, 40);
        assert!(out.ends_with('…') || out.len() <= 40);
        assert!(out.is_char_boundary(out.len().saturating_sub(out.ends_with('…') as usize * "…".len())));
        // Round-trip: truncated prefix must be valid UTF-8 (already str).
        let _ = out.chars().count();
    }
}
