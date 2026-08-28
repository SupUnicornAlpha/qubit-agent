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

fn tool_description(name: &str) -> String {
    let bare = name.strip_prefix("tool/").unwrap_or(name);
    match bare {
        "update_plan" => "Update the structured execution plan (steps/status).".into(),
        "agent.invoke" => "Invoke an isolated specialist subagent (callee_spec_id + goal) for context-split research; returns structured handoff.".into(),
        "assign_task" => "Assign a specialist task by role/goal (fallback when call_team_* is unavailable).".into(),
        "call_mcp" => "Call an MCP tool via {serverName, toolName, arguments?}.".into(),
        n if n.starts_with("call_team_") => {
            format!("Dispatch specialist via A2A ({n}). Prefer for context-split research; args: {{goal}}.")
        }
        "market.resolve_symbol" => "Resolve a ticker/symbol to a canonical market id.".into(),
        "market.readiness" => "Check market data source readiness.".into(),
        "market.data_sources" => "List configured market data sources.".into(),
        "market.snapshot.get" => "Fetch an immutable market snapshot (returns snapshotId). For validation-grade historical backtests, include versioned universe_history membership intervals and a corporate_action_ledger with per-symbol action arrays; fundamental/valuation/estimate factors must additionally carry a versioned fundamental_ledger with each observation's fiscalPeriodEnd and availableAt. Otherwise results remain research-only.".into(),
        "factor.register" => "Register a factor before computing it. Required: name + expr; returns factor id.".into(),
        "factor.compute" => "Compute values for an existing factor. Required: factor_id returned by factor.register + symbols[].".into(),
        "factor.autoEvaluate" => "Evaluate a computed factor across at least three symbols; call factor.compute first.".into(),
        "strategy.create_version" => "Create a strategy version before composing or backtesting; returns strategy_version_id.".into(),
        "strategy.compose" => "Attach factors/rules to an existing strategy. Required: strategy_version_id; call before backtest.run.".into(),
        "backtest.run" => "Run an event-driven backtest. Required: strategy_version_id and symbols[]; compose first or provide signals.".into(),
        "backtest.walk_forward" => "Validate a completed backtest with expanding walk-forward folds. Optional candidates are selected on each training window and frozen before its test window.".into(),
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
                "callee_spec_id": {
                    "type": "string",
                    "description": "Target agent id or role label, e.g. def-news-event / news_event / 新闻事件"
                },
                "agent_ref": { "type": "string", "description": "Alias of callee_spec_id" },
                "role": { "type": "string", "description": "Alias of callee_spec_id (role/label)" },
                "goal": { "type": "string", "description": "Task for the subagent" },
                "task": { "type": "string", "description": "Alias of goal" },
                "handoff": { "type": "object" }
            },
            "required": ["goal", "callee_spec_id"]
        });
    }
    if bare == "update_plan" {
        return json!({
            "type": "object",
            "properties": {
                "mode": { "type": "string", "description": "agent|plan|goal|ask|diagnose" },
                "goal": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string" },
                        "status": { "type": "string" },
                        "success_criteria": { "type": "array", "items": { "type": "string" } }
                    }
                },
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "Optional; auto s1/s2… if omitted" },
                            "title": { "type": "string" },
                            "status": {
                                "type": "string",
                                "description": "pending|in_progress|done|skipped"
                            },
                            "note": { "type": "string" }
                        },
                        "required": ["title"]
                    }
                }
            },
            "required": ["steps"]
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
    if bare == "factor.register" {
        return json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "expr": { "type": "string", "description": "qlib expression" },
                "expression": { "type": "string", "description": "alias of expr" },
                "category": { "type": "string" },
                "lang": { "type": "string" },
                "universe": { "type": "string" },
                "horizon": { "type": "integer" }
            },
            "required": ["name", "expr"],
            "additionalProperties": true
        });
    }
    if bare == "factor.compute" || bare == "factor.autoEvaluate" {
        return json!({
            "type": "object",
            "properties": {
                "factor_id": { "type": "string", "description": "ID returned by factor.register" },
                "factorId": { "type": "string", "description": "alias of factor_id" },
                "symbols": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
                "symbol": { "type": "string" },
                "ticker": { "type": "string" },
                "start_date": { "type": "string", "description": "YYYY-MM-DD" },
                "end_date": { "type": "string", "description": "YYYY-MM-DD" },
                "startDate": { "type": "string" },
                "endDate": { "type": "string" }
            },
            "required": ["factor_id", "symbols"],
            "additionalProperties": true
        });
    }
    if bare == "strategy.create_version" {
        return json!({
            "type": "object",
            "properties": {
                "name": { "type": "string" },
                "style": { "type": "string" },
                "description": { "type": "string" },
                "universe": { "type": "string" }
            },
            "required": ["name"],
            "additionalProperties": true
        });
    }
    if bare == "strategy.compose" {
        return json!({
            "type": "object",
            "properties": {
                "strategy_version_id": { "type": "string" },
                "strategyVersionId": { "type": "string", "description": "alias of strategy_version_id" },
                "factor_ids": { "type": "array", "items": { "type": "string" } },
                "rule_ids": { "type": "array", "items": { "type": "string" } },
                "kind": { "type": "string" },
                "weight_method": { "type": "string" },
                "universe": { "type": "string" }
            },
            "required": ["strategy_version_id"],
            "additionalProperties": true
        });
    }
    if bare == "backtest.run" {
        return json!({
            "type": "object",
            "properties": {
                "strategy_version_id": { "type": "string" },
                "strategyVersionId": { "type": "string", "description": "alias of strategy_version_id" },
                "symbols": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
                "symbol": { "type": "string" },
                "ticker": { "type": "string" },
                "composition_id": { "type": "string" },
                "signals": { "type": "object" },
                "dataset_snapshot_id": { "type": "string" },
                "datasetSnapshotId": { "type": "string", "description": "alias of dataset_snapshot_id" },
                "instruments": {
                    "type": "object",
                    "description": "Point-in-time contract metadata keyed by symbol; required for options, futures, and perpetuals",
                    "additionalProperties": {
                        "type": "object",
                        "properties": {
                            "asset_class": { "type": "string", "enum": ["stock", "future", "option", "crypto"] },
                            "contract_kind": { "type": "string", "enum": ["spot", "perpetual"] },
                            "contract_multiplier": { "type": "number", "exclusiveMinimum": 0 },
                            "lot_size": { "type": "number", "exclusiveMinimum": 0 },
                            "initial_margin_rate": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                            "maintenance_margin_rate": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                            "target_leverage": { "type": "number", "exclusiveMinimum": 0 },
                            "expiry_date": { "type": "string", "description": "YYYY-MM-DD" },
                            "settlement_mode": { "type": "string", "enum": ["cash", "physical"] },
                            "underlying_symbol": { "type": "string" },
                            "strike": { "type": "number" },
                            "option_right": { "type": "string", "enum": ["call", "put"] },
                            "exercise_style": { "type": "string", "enum": ["european", "american"] },
                            "pricing_model": { "type": "string", "enum": ["black_scholes"] },
                            "future_roll": {
                                "type": "object",
                                "description": "Explicit roll instruction; close old and open successor at roll_date. Never infer from a continuous contract symbol.",
                                "properties": {
                                    "roll_date": { "type": "string", "description": "YYYY-MM-DD, strictly before expiry_date" },
                                    "successor_symbol": { "type": "string" }
                                },
                                "required": ["roll_date", "successor_symbol"],
                                "additionalProperties": false
                            }
                        },
                        "required": ["asset_class"],
                        "additionalProperties": true
                    }
                },
                "start_date": { "type": "string", "description": "YYYY-MM-DD" },
                "end_date": { "type": "string", "description": "YYYY-MM-DD" },
                "benchmark": { "type": "string" },
                "capital": { "type": "number" },
                "costs": {
                    "type": "object",
                    "description": "Frozen execution-cost assumptions. A validation-grade run requires cost_model_version, cost_model_source and cost_model_as_of; omitted costs use an unverified research-only default.",
                    "properties": {
                        "commission_bps": { "type": "number", "minimum": 0 },
                        "slippage_bps": { "type": "number", "minimum": 0 },
                        "min_commission": { "type": "number", "minimum": 0 },
                        "slippage_model": { "type": "string", "enum": ["fixed_bps", "square_root", "volatility_adjusted"] },
                        "impact_coefficient": { "type": "number", "minimum": 0 },
                        "max_volume_participation": { "type": "number", "exclusiveMinimum": 0, "maximum": 1 },
                        "borrow_rate_annual_bps": { "type": "number", "minimum": 0 },
                        "restricted_short_symbols": { "type": "array", "items": { "type": "string" } },
                        "cost_model_version": { "type": "string" },
                        "cost_model_source": { "type": "string" },
                        "cost_model_as_of": { "type": "string", "description": "ISO-8601 timestamp" }
                    },
                    "additionalProperties": true
                }
            },
            "required": ["strategy_version_id", "symbols", "dataset_snapshot_id"],
            "additionalProperties": true
        });
    }
    if bare == "backtest.walk_forward" {
        return json!({
            "type": "object",
            "properties": {
                "backtest_run_id": { "type": "string" },
                "backtestRunId": { "type": "string", "description": "alias of backtest_run_id" },
                "folds": { "type": "integer", "minimum": 2, "maximum": 8 },
                "purge_days": { "type": "integer", "minimum": 0, "maximum": 30 },
                "embargo_days": { "type": "integer", "minimum": 0, "maximum": 30 },
                "selection": {
                    "type": "object",
                    "properties": {
                        "objective": { "type": "string", "enum": ["sharpe", "calmar", "annual_return"] },
                        "candidates": {
                            "type": "array",
                            "minItems": 2,
                            "maxItems": 20,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "top_n": { "type": "integer", "minimum": 1 },
                                    "rebalance": { "type": "string", "enum": ["daily", "weekly", "monthly"] },
                                    "long_short": { "type": "boolean" }
                                },
                                "additionalProperties": true
                            }
                        }
                    },
                    "required": ["candidates"],
                    "additionalProperties": true
                }
            },
            "required": ["backtest_run_id"],
            "additionalProperties": true
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
        // Keep the explicit protocol label.  Inferring arbitrary compatible
        // endpoints as OpenAI hides the selected gateway in traces/cost data
        // and recreates ambiguity from the pre-unified provider-specific reasoning path.
        if !t.is_empty() {
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

    #[test]
    fn quant_tool_schemas_expose_required_contract_fields() {
        let factor = tool_parameters_schema("factor.compute");
        assert_eq!(factor["required"], json!(["factor_id", "symbols"]));
        assert!(factor["properties"].get("start_date").is_some());

        let backtest = tool_parameters_schema("backtest.run");
        assert_eq!(
            backtest["required"],
            json!(["strategy_version_id", "symbols", "dataset_snapshot_id"])
        );
        assert!(backtest["properties"].get("composition_id").is_some());
        assert!(backtest["properties"].get("instruments").is_some());
        assert!(backtest["properties"].get("costs").is_some());
        assert!(
            backtest["properties"]["instruments"]["additionalProperties"]["properties"]
                .get("initial_margin_rate")
                .is_some()
        );
        assert!(
            backtest["properties"]["instruments"]["additionalProperties"]["properties"]
                .get("future_roll")
                .is_some()
        );

        let walk_forward = tool_parameters_schema("backtest.walk_forward");
        assert_eq!(walk_forward["required"], json!(["backtest_run_id"]));
        assert_eq!(
            walk_forward["properties"]["selection"]["properties"]["candidates"]["minItems"],
            json!(2)
        );

        let compose = tool_parameters_schema("strategy.compose");
        assert_eq!(compose["required"], json!(["strategy_version_id"]));
    }
}
