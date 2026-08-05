//! OpenAI-compatible chat completions client.

use std::collections::HashMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cancel::CancelToken;
use crate::error::RuntimeError;
use crate::model::{ModelClient, NormalizedToolCall, SampleRequest, SampleResponse};

#[derive(Clone, Debug)]
pub struct OpenAiCompatibleConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    /// Optional timeout seconds.
    pub timeout_secs: u64,
}

impl Default for OpenAiCompatibleConfig {
    fn default() -> Self {
        let api_key = std::env::var("QUBIT_LLM_API_KEY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                std::env::var("OPENAI_API_KEY")
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            });
        Self {
            base_url: std::env::var("QUBIT_LLM_BASE_URL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "https://api.openai.com/v1".into()),
            api_key,
            model: std::env::var("QUBIT_LLM_MODEL")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "gpt-4o-mini".into()),
            timeout_secs: 60,
        }
    }
}

pub struct OpenAiCompatibleClient {
    http: reqwest::Client,
    cfg: OpenAiCompatibleConfig,
    /// Billing / observability provider label (deepseek, openai, …).
    provider: String,
}

impl OpenAiCompatibleClient {
    pub fn new(cfg: OpenAiCompatibleConfig) -> Result<Self, RuntimeError> {
        let mut cfg = cfg;
        cfg.base_url = normalize_openai_base_url(&cfg.base_url);
        let provider = resolve_provider_label(&cfg);
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
            .build()
            .map_err(|e| RuntimeError::Model(e.to_string()))?;
        Ok(Self {
            http,
            cfg,
            provider,
        })
    }

    pub fn from_env() -> Result<Self, RuntimeError> {
        Self::new(OpenAiCompatibleConfig::default())
    }
}

/// Accept either `https://host/v1` or full `.../chat/completions` (as Bun model.json may store).
fn normalize_openai_base_url(raw: &str) -> String {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if let Some(stripped) = s.strip_suffix("/chat/completions") {
        s = stripped.trim_end_matches('/').to_string();
    }
    // DeepSeek's OpenAI-compatible API is under /v1.
    if s.contains("api.deepseek.com") && !s.contains("/v1") {
        s = format!("{s}/v1");
    }
    s
}

fn tool_description(name: &str) -> String {
    let bare = name.strip_prefix("tool/").unwrap_or(name);
    match bare {
        "update_plan" => "Update the structured execution plan (steps/status).".into(),
        "agent.invoke" => "Invoke an isolated subagent with a goal and optional handoff.".into(),
        "call_mcp" => "Call an MCP tool via {serverName, toolName, arguments?}.".into(),
        "market.resolve_symbol" => "Resolve a ticker/symbol to a canonical market id.".into(),
        "market.readiness" => "Check market data source readiness.".into(),
        "market.data_sources" => "List configured market data sources.".into(),
        "market.snapshot.get" => "Fetch an immutable market snapshot (returns snapshotId).".into(),
        n if n.starts_with("mcp:mathjs:") => {
            "Evaluate ONE math expression. Prefer a single call; do not spam.".into()
        }
        n if n.starts_with("mcp:investor-agent:") => {
            format!("Investor-agent MCP tool `{n}`. Cap repeats; prefer synthesizing evidence.")
        }
        n if n.starts_with("mcp:") => format!("MCP tool `{n}`."),
        n => format!("tool {n}"),
    }
}

fn tool_parameters_schema(name: &str) -> Value {
    let bare = name.strip_prefix("tool/").unwrap_or(name);
    if bare == "call_mcp" {
        return json!({
            "type": "object",
            "properties": {
                "serverName": { "type": "string" },
                "toolName": { "type": "string" },
                "mcpTool": { "type": "string" },
                "arguments": { "type": "object" }
            },
            "required": ["serverName"]
        });
    }
    if bare == "agent.invoke" {
        return json!({
            "type": "object",
            "properties": {
                "callee_spec_id": { "type": "string" },
                "goal": { "type": "string" },
                "handoff": { "type": "object" }
            },
            "required": ["goal"]
        });
    }
    if bare == "update_plan" {
        return json!({
            "type": "object",
            "properties": {
                "steps": { "type": "array", "items": { "type": "object" } },
                "mode": { "type": "string" }
            }
        });
    }
    if bare.starts_with("mcp:mathjs:") {
        return json!({
            "type": "object",
            "properties": {
                "expression": { "type": "string", "description": "Single mathjs expression" },
                "expr": { "type": "string", "description": "Alias of expression" }
            }
        });
    }
    if bare.starts_with("market.") {
        return json!({
            "type": "object",
            "properties": {
                "symbol": { "type": "string" },
                "ticker": { "type": "string" },
                "snapshotId": { "type": "string" },
                "interval": { "type": "string" },
                "limit": { "type": "integer" }
            }
        });
    }
    if bare.starts_with("mcp:investor-agent:") {
        return json!({
            "type": "object",
            "properties": {
                "symbol": { "type": "string" },
                "ticker": { "type": "string" },
                "indicator": { "type": "string" },
                "period": { "type": "string" },
                "interval": { "type": "string" }
            }
        });
    }
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string" },
            "symbol": { "type": "string" },
            "arguments": { "type": "object" }
        },
        "additionalProperties": true
    })
}

fn resolve_provider_label(cfg: &OpenAiCompatibleConfig) -> String {
    if let Ok(p) = std::env::var("QUBIT_LLM_PROVIDER") {
        let t = p.trim().to_lowercase();
        if !t.is_empty() && t != "openai_compatible" {
            return t;
        }
    }
    let base = cfg.base_url.to_lowercase();
    let model = cfg.model.to_lowercase();
    if base.contains("deepseek") || model.contains("deepseek") {
        return "deepseek".into();
    }
    if base.contains("anthropic") || model.contains("claude") {
        return "anthropic".into();
    }
    if base.contains("11434") {
        return "ollama".into();
    }
    if base.contains("dashscope") || model.contains("qwen") {
        return "qwen".into();
    }
    if base.contains("bigmodel") || model.contains("glm") {
        return "zhipu".into();
    }
    "openai".into()
}

/// OpenAI/DeepSeek function names must match `^[a-zA-Z0-9_-]+$`.
/// Wire names like `market.resolve_symbol` / `mcp:mathjs:add` are encoded for the API
/// and decoded back before ToolHost routing.
pub fn encode_openai_tool_name(name: &str) -> String {
    if name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return name.to_string();
    }
    let mut out = String::from("q_");
    for b in name.as_bytes() {
        match *b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'-' => out.push(*b as char),
            b'.' => out.push_str("_d_"),
            b':' => out.push_str("_c_"),
            b'/' => out.push_str("_s_"),
            other => out.push_str(&format!("_x{other:02x}_")),
        }
    }
    out
}

pub fn decode_openai_tool_name(encoded: &str, map: &HashMap<String, String>) -> String {
    if let Some(orig) = map.get(encoded) {
        return orig.clone();
    }
    if let Some(rest) = encoded.strip_prefix("q_") {
        let mut out = String::new();
        let bytes = rest.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'_' {
                if rest[i..].starts_with("_d_") {
                    out.push('.');
                    i += 3;
                    continue;
                }
                if rest[i..].starts_with("_c_") {
                    out.push(':');
                    i += 3;
                    continue;
                }
                if rest[i..].starts_with("_s_") {
                    out.push('/');
                    i += 3;
                    continue;
                }
                if rest[i..].len() >= 5
                    && rest[i..].starts_with("_x")
                    && rest.as_bytes().get(i + 4) == Some(&b'_')
                {
                    if let Ok(v) = u8::from_str_radix(&rest[i + 2..i + 4], 16) {
                        out.push(v as char);
                        i += 5;
                        continue;
                    }
                }
            }
            out.push(bytes[i] as char);
            i += 1;
        }
        return out;
    }
    encoded.to_string()
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<Choice>,
    #[serde(default)]
    usage: Option<ApiUsage>,
    #[serde(default)]
    model: Option<String>,
}

#[derive(Deserialize)]
struct ApiUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
    #[serde(default)]
    total_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ApiToolCall>>,
}

#[derive(Deserialize)]
struct ApiToolCall {
    id: String,
    function: ApiFunction,
}

#[derive(Deserialize)]
struct ApiFunction {
    name: String,
    arguments: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Value>>,
}

#[async_trait]
impl ModelClient for OpenAiCompatibleClient {
    async fn sample(
        &self,
        req: SampleRequest,
        cancel: CancelToken,
    ) -> Result<SampleResponse, RuntimeError> {
        cancel.check()?;
        let url = format!(
            "{}/chat/completions",
            self.cfg.base_url.trim_end_matches('/')
        );

        let mut encode_map: HashMap<String, String> = HashMap::new();
        let tools = if req.tools.is_empty() {
            None
        } else {
            Some(
                req.tools
                    .iter()
                    .map(|name| {
                        let encoded = encode_openai_tool_name(name);
                        encode_map.insert(encoded.clone(), name.clone());
                        json!({
                            "type": "function",
                            "function": {
                                "name": encoded,
                                "description": tool_description(name),
                                "parameters": tool_parameters_schema(name)
                            }
                        })
                    })
                    .collect(),
            )
        };

        let body = ChatRequest {
            model: &self.cfg.model,
            messages: {
                let mut msgs = vec![
                    json!({"role": "system", "content": req.system}),
                    json!({"role": "user", "content": req.user}),
                ];
                msgs.extend(req.history);
                msgs
            },
            tools,
        };

        let mut builder = self.http.post(&url).json(&body);
        if let Some(ref key) = self.cfg.api_key {
            builder = builder.bearer_auth(key);
        }

        let started = std::time::Instant::now();
        let resp = tokio::select! {
            _ = cancel.cancelled() => {
                return Err(RuntimeError::Cancelled);
            }
            result = builder.send() => {
                result.map_err(|e| RuntimeError::Model(e.to_string()))?
            }
        };
        cancel.check()?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(RuntimeError::Model(format!("HTTP {status}: {text}")));
        }
        let parsed: ChatCompletionResponse = resp
            .json()
            .await
            .map_err(|e| RuntimeError::Model(e.to_string()))?;
        let latency_ms = started.elapsed().as_millis() as u64;
        let usage = parsed.usage;
        let model_name = parsed.model.or_else(|| Some(self.cfg.model.clone()));
        let msg = parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message)
            .ok_or_else(|| RuntimeError::Model("empty choices".into()))?;

        let mut tool_calls = Vec::new();
        if let Some(calls) = msg.tool_calls {
            for c in calls {
                let args: Value = serde_json::from_str(&c.function.arguments)
                    .unwrap_or_else(|_| json!({ "raw": c.function.arguments }));
                tool_calls.push(NormalizedToolCall {
                    call_id: c.id,
                    name: decode_openai_tool_name(&c.function.name, &encode_map),
                    args,
                });
            }
        }

        Ok(SampleResponse {
            text: msg.content.unwrap_or_default(),
            tool_calls,
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
            prompt_tokens: usage.as_ref().and_then(|u| u.prompt_tokens),
            completion_tokens: usage.as_ref().and_then(|u| u.completion_tokens),
            total_tokens: usage.as_ref().and_then(|u| u.total_tokens),
            latency_ms: Some(latency_ms),
            model: model_name,
            provider: Some(self.provider.clone()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_openai_illegal_tool_names() {
        assert_eq!(encode_openai_tool_name("call_mcp"), "call_mcp");
        assert_eq!(
            encode_openai_tool_name("market.resolve_symbol"),
            "q_market_d_resolve_symbol"
        );
        assert_eq!(
            encode_openai_tool_name("mcp:mathjs:add"),
            "q_mcp_c_mathjs_c_add"
        );
        assert_eq!(encode_openai_tool_name("agent.invoke"), "q_agent_d_invoke");
    }

    #[test]
    fn decodes_openai_tool_names_roundtrip() {
        let names = [
            "call_mcp",
            "market.resolve_symbol",
            "mcp:mathjs:add",
            "agent.invoke",
            "update_plan",
        ];
        let mut map = HashMap::new();
        for n in names {
            let e = encode_openai_tool_name(n);
            map.insert(e.clone(), n.to_string());
            assert_eq!(decode_openai_tool_name(&e, &map), n);
            if e.starts_with("q_") {
                assert_eq!(decode_openai_tool_name(&e, &HashMap::new()), n);
            }
        }
    }
}
