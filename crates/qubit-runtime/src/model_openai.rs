//! OpenAI-compatible chat completions client.

use std::collections::HashMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::cancel::CancelToken;
use crate::error::RuntimeError;
use crate::model::{ModelClient, NormalizedToolCall, SampleRequest, SampleResponse};
use crate::reasoning_extract::{estimate_reasoning_tokens, extract_reasoning_from_chat_completion};

#[derive(Clone, Debug)]
pub struct OpenAiCompatibleConfig {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    /// Optional timeout seconds.
    pub timeout_secs: u64,
    /// Transient body/network failures before giving up (DeepSeek truncations, etc.).
    pub max_retries: u32,
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
        let timeout_secs = std::env::var("QUBIT_LLM_TIMEOUT_SECS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|&n| n > 0)
            .unwrap_or(180);
        let max_retries = std::env::var("QUBIT_LLM_MAX_RETRIES")
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(2);
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
            timeout_secs,
            max_retries,
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
            .connect_timeout(std::time::Duration::from_secs(30))
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

fn is_transient_model_error(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("error decoding response body")
        || m.contains("connection reset")
        || m.contains("connection closed")
        || m.contains("broken pipe")
        || m.contains("timed out")
        || m.contains("timeout")
        || m.contains("temporarily unavailable")
        || m.contains("502")
        || m.contains("503")
        || m.contains("504")
        || m.contains("incomplete")
        || m.contains("unexpected eof")
        || m.contains("body") && m.contains("decode")
}

fn body_preview(bytes: &[u8], max: usize) -> String {
    let n = bytes.len().min(max);
    let s = String::from_utf8_lossy(&bytes[..n]);
    let compact: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if bytes.len() > max {
        format!("{compact}…(total {} bytes)", bytes.len())
    } else {
        compact
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

fn resolve_provider_label(cfg: &OpenAiCompatibleConfig) -> String {
    if let Ok(provider) = std::env::var("QUBIT_LLM_PROVIDER") {
        let normalized = provider.trim().to_ascii_lowercase();
        if !normalized.is_empty() {
            return normalized;
        }
    }
    let base = cfg.base_url.to_ascii_lowercase();
    let model = cfg.model.to_ascii_lowercase();
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

/// Encode provider-specific tool names. Tool metadata is supplied by ToolHost;
/// this adapter only translates the provider wire format.

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
struct ApiUsage {
    #[serde(default)]
    prompt_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens: Option<u32>,
    #[serde(default)]
    total_tokens: Option<u32>,
    #[serde(default)]
    completion_tokens_details: Option<CompletionTokensDetails>,
}

#[derive(Deserialize)]
struct CompletionTokensDetails {
    #[serde(default)]
    reasoning_tokens: Option<u32>,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Value>>,
}

/// OpenAI-compatible vision payload; models without vision support return their native 4xx.
fn user_content_with_images(user: &str, image_urls: &[String]) -> Value {
    if image_urls.is_empty() {
        return Value::String(user.to_string());
    }
    let mut blocks = vec![json!({ "type": "text", "text": user })];
    blocks.extend(
        image_urls
            .iter()
            .map(|url| json!({ "type": "image_url", "image_url": { "url": url } })),
    );
    Value::Array(blocks)
}

/// Prefer string content; Anthropic-compat content arrays use text blocks for answer.
fn extract_answer_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => {
            let mut texts = Vec::new();
            for block in blocks {
                let ty = block
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("text")
                    .to_ascii_lowercase();
                if matches!(
                    ty.as_str(),
                    "thinking" | "redacted_thinking" | "reasoning" | "reasoning_content"
                ) {
                    continue;
                }
                if block
                    .get("thought")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                {
                    continue;
                }
                if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                    if !t.is_empty() {
                        texts.push(t.to_string());
                    }
                } else if let Some(t) = block.get("content").and_then(|v| v.as_str()) {
                    if !t.is_empty() {
                        texts.push(t.to_string());
                    }
                }
            }
            texts.join("\n")
        }
        Some(Value::Null) | None => String::new(),
        Some(other) => other.as_str().map(|s| s.to_string()).unwrap_or_default(),
    }
}

fn extract_tool_calls(
    message: &Value,
    encode_map: &HashMap<String, String>,
) -> Vec<NormalizedToolCall> {
    let Some(Value::Array(calls)) = message.get("tool_calls") else {
        return vec![];
    };
    let mut tool_calls = Vec::new();
    for c in calls {
        let id = c
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let name = c
            .pointer("/function/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args_raw = c
            .pointer("/function/arguments")
            .cloned()
            .unwrap_or(Value::Null);
        let args: Value = match args_raw {
            Value::String(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({ "raw": s })),
            other => other,
        };
        if id.is_empty() || name.is_empty() {
            continue;
        }
        tool_calls.push(NormalizedToolCall {
            call_id: id,
            name: decode_openai_tool_name(&name, encode_map),
            args,
        });
    }
    tool_calls
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
                    .map(|definition| {
                        let encoded = encode_openai_tool_name(&definition.name);
                        encode_map.insert(encoded.clone(), definition.name.clone());
                        json!({
                            "type": "function",
                            "function": {
                                "name": encoded,
                                "description": definition.description,
                                "parameters": definition.parameters
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
                    json!({"role": "user", "content": user_content_with_images(&req.user, &req.image_urls)}),
                ];
                msgs.extend(req.history);
                msgs
            },
            tools,
        };

        let started = std::time::Instant::now();
        let attempts = self.cfg.max_retries.saturating_add(1).max(1);
        let mut last_err = String::new();

        for attempt in 1..=attempts {
            cancel.check()?;
            let mut builder = self
                .http
                .post(&url)
                .header("Accept-Encoding", "identity")
                .json(&body);
            if let Some(ref key) = self.cfg.api_key {
                builder = builder.bearer_auth(key);
            }

            let resp = tokio::select! {
                _ = cancel.cancelled() => {
                    return Err(RuntimeError::Cancelled);
                }
                result = builder.send() => {
                    match result {
                        Ok(r) => r,
                        Err(e) => {
                            last_err = e.to_string();
                            if attempt < attempts && is_transient_model_error(&last_err) {
                                tracing::warn!(
                                    attempt,
                                    attempts,
                                    error = %last_err,
                                    "LLM transport error; retrying"
                                );
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    400 * u64::from(attempt),
                                ))
                                .await;
                                continue;
                            }
                            return Err(RuntimeError::Model(last_err));
                        }
                    }
                }
            };
            cancel.check()?;

            let status = resp.status();
            let bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    last_err = format!("error reading response body: {e}");
                    if attempt < attempts && is_transient_model_error(&last_err) {
                        tracing::warn!(
                            attempt,
                            attempts,
                            error = %last_err,
                            "LLM body read failed; retrying"
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(
                            400 * u64::from(attempt),
                        ))
                        .await;
                        continue;
                    }
                    return Err(RuntimeError::Model(last_err));
                }
            };

            if !status.is_success() {
                let text = String::from_utf8_lossy(&bytes);
                last_err = format!("HTTP {status}: {text}");
                // Retry upstream 5xx; treat 4xx as final.
                if attempt < attempts
                    && (status.is_server_error() || is_transient_model_error(&last_err))
                {
                    tracing::warn!(
                        attempt,
                        attempts,
                        %status,
                        "LLM HTTP error; retrying"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(400 * u64::from(attempt)))
                        .await;
                    continue;
                }
                return Err(RuntimeError::Model(last_err));
            }

            let root: Value = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    last_err = format!(
                        "error decoding response body: {e}; preview={}",
                        body_preview(&bytes, 480)
                    );
                    if attempt < attempts {
                        tracing::warn!(
                            attempt,
                            attempts,
                            error = %last_err,
                            "LLM JSON decode failed; retrying"
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(
                            400 * u64::from(attempt),
                        ))
                        .await;
                        continue;
                    }
                    return Err(RuntimeError::Model(last_err));
                }
            };

            let latency_ms = started.elapsed().as_millis() as u64;
            let message = root
                .pointer("/choices/0/message")
                .cloned()
                .ok_or_else(|| RuntimeError::Model("empty choices".into()))?;

            let usage: Option<ApiUsage> = root
                .get("usage")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            let model_name = root
                .get("model")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| Some(self.cfg.model.clone()));

            let reasoning_text = extract_reasoning_from_chat_completion(&root);
            let mut reasoning_tokens = usage
                .as_ref()
                .and_then(|u| u.completion_tokens_details.as_ref())
                .and_then(|d| d.reasoning_tokens);
            if reasoning_tokens.is_none() {
                if let Some(ref r) = reasoning_text {
                    let est = estimate_reasoning_tokens(r.chars().count());
                    if est > 0 {
                        reasoning_tokens = Some(est);
                    }
                }
            }

            let tool_calls = extract_tool_calls(&message, &encode_map);
            let text = extract_answer_text(&message);

            return Ok(SampleResponse {
                text,
                reasoning_text,
                tool_calls,
                request_hitl: false,
                hitl_title: None,
                hitl_body: None,
                prompt_tokens: usage.as_ref().and_then(|u| u.prompt_tokens),
                completion_tokens: usage.as_ref().and_then(|u| u.completion_tokens),
                total_tokens: usage.as_ref().and_then(|u| u.total_tokens),
                reasoning_tokens,
                latency_ms: Some(latency_ms),
                model: model_name,
                provider: Some(self.provider.clone()),
            });
        }

        Err(RuntimeError::Model(if last_err.is_empty() {
            "LLM request failed after retries".into()
        } else {
            last_err
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_transient_decode_errors() {
        assert!(is_transient_model_error("error decoding response body"));
        assert!(is_transient_model_error(
            "error reading response body: unexpected EOF"
        ));
        assert!(is_transient_model_error("HTTP 503: unavailable"));
        assert!(!is_transient_model_error("HTTP 401: invalid api key"));
    }

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

    #[test]
    fn encodes_image_inputs_as_openai_content_blocks() {
        let image = "data:image/png;base64,AA==".to_string();
        assert_eq!(
            user_content_with_images("analyse this", &[]),
            Value::String("analyse this".into())
        );
        assert_eq!(
            user_content_with_images("analyse this", &[image.clone()]),
            json!([
                { "type": "text", "text": "analyse this" },
                { "type": "image_url", "image_url": { "url": image } }
            ])
        );
    }
}
