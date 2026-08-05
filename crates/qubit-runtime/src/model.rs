use async_trait::async_trait;
use serde_json::Value;

use crate::cancel::CancelToken;
use crate::error::RuntimeError;

#[derive(Clone, Debug)]
pub struct SampleRequest {
    pub system: String,
    pub user: String,
    pub tools: Vec<String>,
    /// Prior assistant/tool turns after the initial system+user (OpenAI chat format).
    pub history: Vec<Value>,
}

impl SampleRequest {
    pub fn simple(system: impl Into<String>, user: impl Into<String>, tools: Vec<String>) -> Self {
        Self {
            system: system.into(),
            user: user.into(),
            tools,
            history: vec![],
        }
    }
}

#[derive(Clone, Debug)]
pub struct SampleResponse {
    pub text: String,
    pub tool_calls: Vec<NormalizedToolCall>,
    pub request_hitl: bool,
    pub hitl_title: Option<String>,
    pub hitl_body: Option<String>,
    pub prompt_tokens: Option<u32>,
    pub completion_tokens: Option<u32>,
    pub total_tokens: Option<u32>,
    pub latency_ms: Option<u64>,
    pub model: Option<String>,
    pub provider: Option<String>,
}

impl Default for SampleResponse {
    fn default() -> Self {
        Self::text_only("")
    }
}

impl SampleResponse {
    pub fn text_only(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            tool_calls: vec![],
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: None,
            latency_ms: None,
            model: None,
            provider: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct NormalizedToolCall {
    pub call_id: String,
    pub name: String,
    pub args: Value,
}

#[async_trait]
pub trait ModelClient: Send + Sync {
    async fn sample(
        &self,
        req: SampleRequest,
        cancel: CancelToken,
    ) -> Result<SampleResponse, RuntimeError>;
}

/// Stub model when no LLM is configured. Never echo the assembled prompt —
/// that would leak workspace paths / identity / MODE=control into the chat UI.
#[derive(Debug, Default)]
pub struct FakeModelClient;

#[async_trait]
impl ModelClient for FakeModelClient {
    async fn sample(
        &self,
        _req: SampleRequest,
        cancel: CancelToken,
    ) -> Result<SampleResponse, RuntimeError> {
        cancel.check()?;
        Ok(SampleResponse {
            text: "(Core: no LLM configured. Set QUBIT_LLM_API_KEY / QUBIT_LLM_MODEL, or configure .qubit/model.json and restart.)".into(),
            tool_calls: vec![],
            request_hitl: false,
            hitl_title: None,
            hitl_body: None,
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: None,
            latency_ms: None,
            model: None,
            provider: None,
        })
    }
}

/// Slow model that polls cancel — used for M6 cancel tests.
pub struct CancellableSlowModel {
    pub delay_ms: u64,
    pub polls: u32,
}

#[async_trait]
impl ModelClient for CancellableSlowModel {
    async fn sample(
        &self,
        req: SampleRequest,
        cancel: CancelToken,
    ) -> Result<SampleResponse, RuntimeError> {
        let step = (self.delay_ms / self.polls.max(1) as u64).max(1);
        for _ in 0..self.polls.max(1) {
            cancel.check()?;
            tokio::time::sleep(std::time::Duration::from_millis(step)).await;
        }
        cancel.check()?;
        Ok(SampleResponse {
            text: format!("slow: {}", req.user),
            ..SampleResponse::default()
        })
    }
}

/// Scripted model that returns a fixed sequence of responses (for L0 / plan tests).
pub struct ScriptedModelClient {
    pub responses: std::sync::Mutex<Vec<SampleResponse>>,
}

impl ScriptedModelClient {
    pub fn once(response: SampleResponse) -> Self {
        Self {
            responses: std::sync::Mutex::new(vec![response]),
        }
    }

    pub fn sequence(responses: Vec<SampleResponse>) -> Self {
        Self {
            responses: std::sync::Mutex::new(responses),
        }
    }
}

#[async_trait]
impl ModelClient for ScriptedModelClient {
    async fn sample(
        &self,
        _req: SampleRequest,
        cancel: CancelToken,
    ) -> Result<SampleResponse, RuntimeError> {
        cancel.check()?;
        let mut g = self
            .responses
            .lock()
            .map_err(|_| RuntimeError::Internal("scripted model lock".into()))?;
        if g.is_empty() {
            return Ok(SampleResponse::default());
        }
        Ok(g.remove(0))
    }
}
