//! Legacy Bun bridge client (01 §11.2).
//!
//! Wire: POST `{base}/rpc` JSON-RPC 2.0
//! - `legacy.tools.list` → `{ tools: LegacyToolSpec[] }`
//! - `legacy.tools.invoke` → LegacyInvokeResult (normalized to ToolResult fields)

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::ToolHostError;

/// Default allowlisted builtins for M4+ grayscale (+ memory for Core RecallPort).
/// Topology `call_team_*` are advertised dynamically via Bun `legacy.tools.list`.
pub const DEFAULT_BRIDGED_TOOLS: &[&str] = &[
    // User scope / market context
    "market.ide_subscription.get",
    "market.broker_quote.get",
    "market.resolve_symbol",
    "market.readiness",
    "market.data_sources",
    "market.snapshot.get",
    // Prime workflow state and learning
    "memory.recall",
    "memory.consolidate_longterm",
    "memory.refresh_workspace",
    "skill.search",
    "skill.use_record",
    "skill.create",
    "skill.patch",
    "skill.archive",
    "workspace.memory.search",
    // Research / strategy contracts
    "run_screener",
    "research.thesis.write",
    "research.forecast_book.get",
    "portfolio.construct",
    "recommendation.record",
    "discovery.run",
    "discovery.promote",
    "rule.register",
    "strategy.create_version",
    "strategy.compose",
    "strategy.compile",
    "strategy.contract_backtest",
    "strategy.paper_deploy",
    "strategy.paper_run",
    "strategy.sim_deploy",
    "factor.register",
    "factor.list",
    "factor.compute",
    "factor.autoEvaluate",
    "factor.mine.llm",
    "factor.promote_backtest",
    "backtest.run",
    "workspace.context.snapshot",
    "web.search",
    "web.fetch",
    // Keep this fallback surface aligned with Bun's BRIDGED_TOOLS. Core does
    // not resolve tools:// AgentSpec refs yet, so specialists need their
    // domain tools here even when legacy.tools.list is temporarily unavailable.
    "fetch_klines",
    "fetch_quote",
    "fetch_ticks",
    "fetch_option_chain",
    "fetch_fundamentals",
    "fetch_news",
    "fetch_news_sentiment",
    "compute_indicators",
    "detect_patterns",
    "compute_valuation",
    "compute_macro_indicators",
    "order.create_intent",
    "evaluate_risk",
];

/// Whether a tool name is acceptable on the legacy bridge (static list + team dispatch).
pub fn is_default_bridged_tool_name(name: &str) -> bool {
    let n = name.trim();
    if n.is_empty() {
        return false;
    }
    if DEFAULT_BRIDGED_TOOLS.iter().any(|t| *t == n) {
        return true;
    }
    n.starts_with("call_team_")
}

#[cfg(test)]
mod tests {
    use super::is_default_bridged_tool_name;

    #[test]
    fn fallback_surface_contains_specialist_domain_tools() {
        for name in [
            "market.ide_subscription.get",
            "market.broker_quote.get",
            "fetch_fundamentals",
            "fetch_quote",
            "fetch_ticks",
            "fetch_option_chain",
            "compute_valuation",
            "fetch_klines",
            "compute_indicators",
            "fetch_news",
            "strategy.sim_deploy",
        ] {
            assert!(
                is_default_bridged_tool_name(name),
                "missing specialist bridge tool: {name}"
            );
        }
    }
}

#[derive(Clone, Debug)]
pub struct LegacyBridgeConfig {
    /// e.g. `http://127.0.0.1:3000/api/v1/prime-bridge`
    pub base_url: String,
    pub timeout_secs: u64,
}

impl LegacyBridgeConfig {
    pub fn from_env() -> Option<Self> {
        let base_url = std::env::var("QUBIT_LEGACY_BRIDGE_URL").ok()?;
        if base_url.trim().is_empty() {
            return None;
        }
        Some(Self {
            base_url,
            timeout_secs: std::env::var("QUBIT_LEGACY_BRIDGE_TIMEOUT_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(120),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LegacyToolSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LegacyInvokeParams {
    pub call_id: String,
    pub name: String,
    pub args: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    /// Bun workflow correlation (`wf_<workflowId>` from Core session).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LegacyInvokeResult {
    pub call_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<Value>,
    #[serde(default)]
    pub effects: Vec<LegacyEffect>,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LegacyEffect {
    pub kind: String,
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

pub struct LegacyBridgeClient {
    http: reqwest::Client,
    cfg: LegacyBridgeConfig,
}

impl LegacyBridgeClient {
    pub fn new(cfg: LegacyBridgeConfig) -> Result<Self, ToolHostError> {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(cfg.timeout_secs))
            .build()
            .map_err(|e| ToolHostError::Http(e.to_string()))?;
        Ok(Self { http, cfg })
    }

    async fn rpc(&self, method: &str, params: Value) -> Result<Value, ToolHostError> {
        let url = format!("{}/rpc", self.cfg.base_url.trim_end_matches('/'));
        let body = json!({
            "jsonrpc": "2.0",
            "id": uuid::Uuid::new_v4().to_string(),
            "method": method,
            "params": params,
        });
        let resp = self
            .http
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| ToolHostError::Unavailable(e.to_string()))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(ToolHostError::Http(format!("{status}: {text}")));
        }
        let v: Value = resp
            .json()
            .await
            .map_err(|e| ToolHostError::Invalid(e.to_string()))?;
        if let Some(err) = v.get("error") {
            return Err(ToolHostError::Rpc(err.to_string()));
        }
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    }

    pub async fn list_tools(&self) -> Result<Vec<LegacyToolSpec>, ToolHostError> {
        let result = self.rpc("legacy.tools.list", json!({})).await?;
        let tools = result.get("tools").cloned().unwrap_or(Value::Array(vec![]));
        serde_json::from_value(tools).map_err(|e| ToolHostError::Invalid(e.to_string()))
    }

    pub async fn invoke(
        &self,
        params: LegacyInvokeParams,
    ) -> Result<LegacyInvokeResult, ToolHostError> {
        let result = self
            .rpc(
                "legacy.tools.invoke",
                serde_json::to_value(&params).unwrap(),
            )
            .await?;
        serde_json::from_value(result).map_err(|e| ToolHostError::Invalid(e.to_string()))
    }
}
