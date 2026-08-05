//! RecallPort via Legacy Bun bridge — Experience + FS workspace memory (B4 OUT store).

use std::sync::Arc;

use async_trait::async_trait;
use qubit_tool_host::{LegacyBridgeClient, LegacyInvokeParams};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::error::RuntimeError;

use super::ports::{RecallHit, RecallPort};

pub struct BridgeRecallPort {
    client: Arc<LegacyBridgeClient>,
}

impl BridgeRecallPort {
    pub fn new(client: Arc<LegacyBridgeClient>) -> Self {
        Self { client }
    }

    async fn invoke_hits(
        &self,
        tool: &str,
        query: &str,
        extra: Value,
    ) -> Result<Vec<RecallHit>, RuntimeError> {
        let mut args = json!({ "query": query, "top_k": 5 });
        if let Some(obj) = args.as_object_mut() {
            if let Some(extra_obj) = extra.as_object() {
                for (k, v) in extra_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        let result = self
            .client
            .invoke(LegacyInvokeParams {
                call_id: format!("recall_{}", Uuid::new_v4().simple()),
                name: tool.to_string(),
                args,
                idempotency_key: None,
                workspace_id: None,
                session_id: None,
            })
            .await
            .map_err(|e| RuntimeError::Internal(format!("bridge recall: {e}")))?;
        if !result.ok {
            tracing::warn!(
                tool,
                error = ?result.error_code,
                "bridge recall failed; returning empty"
            );
            return Ok(vec![]);
        }
        Ok(parse_hits(result.observation.as_ref()))
    }
}

fn parse_hits(obs: Option<&Value>) -> Vec<RecallHit> {
    let Some(obs) = obs else {
        return vec![];
    };
    let hits = obs
        .get("hits")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    hits.into_iter()
        .filter_map(|h| {
            let title = h
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("memory")
                .to_string();
            let summary = h
                .get("summary")
                .or_else(|| h.get("body"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if summary.trim().is_empty() && title == "memory" {
                return None;
            }
            Some(RecallHit {
                title,
                summary,
                sub_kind: h
                    .get("sub_kind")
                    .or_else(|| h.get("kind"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                asof: h
                    .get("asof")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                score: h.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0),
            })
        })
        .collect()
}

#[async_trait]
impl RecallPort for BridgeRecallPort {
    async fn recall_finance(&self, query: &str) -> Result<Vec<RecallHit>, RuntimeError> {
        self.invoke_hits("memory.recall", query, json!({ "mode": "finance" }))
            .await
    }

    async fn recall_skill(&self, query: &str) -> Result<Vec<RecallHit>, RuntimeError> {
        self.invoke_hits(
            "memory.recall",
            query,
            json!({ "kinds": ["procedural"] }),
        )
        .await
    }

    async fn recall_general(&self, query: &str) -> Result<Vec<RecallHit>, RuntimeError> {
        // Dual recall: Experience + FS workspace memory (merged on Bun side).
        self.invoke_hits("memory.recall", query, json!({ "include_fs": true }))
            .await
    }
}
