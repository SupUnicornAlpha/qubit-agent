//! HITL policy for Core turns (mirrors Bun `evaluateChatHitlTrigger` for tool batches).

use serde_json::Value;

use crate::model::NormalizedToolCall;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HitlMode {
    Off,
    Ai,
    Always,
}

impl HitlMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" => Self::Off,
            "always" => Self::Always,
            _ => Self::Ai,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HitlPolicy {
    pub mode: HitlMode,
    /// After Bun HITL approve + new turn: allow the first tool batch under mode=always.
    /// High-risk tools still force HITL.
    pub skip_tool_gate_once: bool,
}

impl Default for HitlPolicy {
    fn default() -> Self {
        Self {
            mode: HitlMode::Ai,
            skip_tool_gate_once: false,
        }
    }
}

impl HitlPolicy {
    /// Read `{ "hitl": { "mode": "always"|"ai"|"off", "skip_tool_gate_once": bool } }` from `UserInput.client_meta`.
    pub fn from_client_meta(meta: Option<&Value>) -> Self {
        let Some(meta) = meta else {
            return Self::default();
        };
        let mode = meta
            .pointer("/hitl/mode")
            .and_then(|v| v.as_str())
            .or_else(|| meta.get("hitl_mode").and_then(|v| v.as_str()))
            .map(HitlMode::parse)
            .unwrap_or(HitlMode::Ai);
        let skip_tool_gate_once = meta
            .pointer("/hitl/skip_tool_gate_once")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        Self {
            mode,
            skip_tool_gate_once,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolHitlDecision {
    pub trigger: bool,
    pub source: &'static str,
    pub reason: String,
    pub title: String,
    pub body: String,
    pub hard_rule: bool,
}

/// High-risk tools: money / irreversible / self-modifying (aligned with Bun `isHighRiskChatTool`).
pub fn is_high_risk_tool(tool_name: &str) -> bool {
    let name = tool_name.trim();
    if name.is_empty() {
        return false;
    }
    let n = name.to_ascii_lowercase();
    let patterns = [
        "place_order",
        "submit_order",
        "create_order",
        "cancel_order",
        "modify_order",
        "broker_",
        "edit_agent_pack",
        "update_agent_definition",
    ];
    if patterns.iter().any(|p| n.contains(p)) {
        return true;
    }
    // delete_/purge_/wipe_/reset_ style
    for prefix in ["delete_", "purge_", "wipe_", "reset_"] {
        if n.contains(prefix) {
            return true;
        }
    }
    false
}

pub fn evaluate_tool_batch_hitl(
    policy: &HitlPolicy,
    tools: &[NormalizedToolCall],
) -> ToolHitlDecision {
    if tools.is_empty() {
        return ToolHitlDecision {
            trigger: false,
            source: "none",
            reason: String::new(),
            title: String::new(),
            body: String::new(),
            hard_rule: false,
        };
    }

    let names: Vec<&str> = tools
        .iter()
        .map(|t| t.name.strip_prefix("tool/").unwrap_or(t.name.as_str()))
        .collect();
    let high: Vec<&str> = names
        .iter()
        .copied()
        .filter(|n| is_high_risk_tool(n))
        .collect();

    if !high.is_empty() {
        let list = high.join(", ");
        return ToolHitlDecision {
            trigger: true,
            source: "rule_high_risk",
            reason: format!("高危工具需人工确认：{list}"),
            title: format!("高危工具待确认：{list}"),
            body: format!(
                "Core 即将调用高危工具，请批准后继续。\n工具：{list}\n（命中硬规则，无视 HITL=关闭）"
            ),
            hard_rule: true,
        };
    }

    match policy.mode {
        HitlMode::Always => {
            if policy.skip_tool_gate_once {
                return ToolHitlDecision {
                    trigger: false,
                    source: "skip_once",
                    reason: String::new(),
                    title: String::new(),
                    body: String::new(),
                    hard_rule: false,
                };
            }
            let list = names.join(", ");
            ToolHitlDecision {
                trigger: true,
                source: "mode_always",
                reason: "用户设置每次工具调用都需要人工确认".into(),
                title: "工具调用待确认".into(),
                body: format!("HITL=每次：Core 调用工具前需批准。\n本批工具：{list}"),
                hard_rule: false,
            }
        }
        HitlMode::Off => ToolHitlDecision {
            trigger: false,
            source: "mode_off",
            reason: String::new(),
            title: String::new(),
            body: String::new(),
            hard_rule: false,
        },
        HitlMode::Ai => ToolHitlDecision {
            trigger: false,
            source: "none",
            reason: String::new(),
            title: String::new(),
            body: String::new(),
            hard_rule: false,
        },
    }
}

const HITL_HINT_DELIMITER: &str = "---HITL_HINT_JSON---";

/// Parse Bun-compatible `---HITL_HINT_JSON---` block; used when mode=ai.
pub fn extract_ai_hitl_hint(text: &str) -> Option<(String, String)> {
    let idx = text.find(HITL_HINT_DELIMITER)?;
    let rest = &text[idx + HITL_HINT_DELIMITER.len()..];
    let start = rest.find('{')?;
    let end = rest[start..].rfind('}')?;
    let json_str = &rest[start..=start + end];
    let v: Value = serde_json::from_str(json_str).ok()?;
    if v.get("needed").and_then(|x| x.as_bool()) != Some(true) {
        return None;
    }
    let title = v
        .get("question")
        .or_else(|| v.get("reason"))
        .and_then(|x| x.as_str())
        .unwrap_or("Orchestrator 请求人工确认")
        .chars()
        .take(120)
        .collect::<String>();
    let body = v
        .get("reason")
        .or_else(|| v.get("question"))
        .and_then(|x| x.as_str())
        .unwrap_or("请确认后继续。")
        .chars()
        .take(2000)
        .collect::<String>();
    Some((title, body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_client_meta_mode() {
        let p = HitlPolicy::from_client_meta(Some(&json!({"hitl":{"mode":"always"}})));
        assert_eq!(p.mode, HitlMode::Always);
        let p2 = HitlPolicy::from_client_meta(None);
        assert_eq!(p2.mode, HitlMode::Ai);
    }

    #[test]
    fn high_risk_and_always() {
        assert!(is_high_risk_tool("broker_place_order"));
        assert!(!is_high_risk_tool("fetch_klines"));
        let tools = vec![NormalizedToolCall {
            call_id: "1".into(),
            name: "fetch_klines".into(),
            args: json!({}),
        }];
        let always = evaluate_tool_batch_hitl(
            &HitlPolicy {
                mode: HitlMode::Always,
                skip_tool_gate_once: false,
            },
            &tools,
        );
        assert!(always.trigger);
        assert_eq!(always.source, "mode_always");
        let off = evaluate_tool_batch_hitl(
            &HitlPolicy {
                mode: HitlMode::Off,
                skip_tool_gate_once: false,
            },
            &tools,
        );
        assert!(!off.trigger);
        let risky = vec![NormalizedToolCall {
            call_id: "1".into(),
            name: "place_order".into(),
            args: json!({}),
        }];
        let forced = evaluate_tool_batch_hitl(
            &HitlPolicy {
                mode: HitlMode::Off,
                skip_tool_gate_once: false,
            },
            &risky,
        );
        assert!(forced.trigger);
        assert_eq!(forced.source, "rule_high_risk");
    }

    #[test]
    fn parses_ai_hint_delimiter() {
        let text = "计划如下\n---HITL_HINT_JSON---\n{\"needed\":true,\"reason\":\"确认仓位\"}";
        let (t, b) = extract_ai_hitl_hint(text).unwrap();
        assert!(t.contains("确认") || b.contains("确认"));
        assert!(extract_ai_hitl_hint("no hint").is_none());
    }
}
