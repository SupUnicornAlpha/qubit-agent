//! Ports that fill context slots — implementations live OUT of harness.

use async_trait::async_trait;

use crate::error::RuntimeError;

#[derive(Clone, Debug, Default)]
pub struct RecallHit {
    pub title: String,
    pub summary: String,
    pub sub_kind: Option<String>,
    pub asof: Option<String>,
    pub score: f64,
}

/// One assemble-round memory pull (finance + skill + general/FS).
#[derive(Clone, Debug, Default)]
pub struct RecallBundle {
    pub finance: Vec<RecallHit>,
    pub skill: Vec<RecallHit>,
    pub general: Vec<RecallHit>,
}

/// Correlation required by host-backed recall. Memory and Skills are project /
/// workflow scoped; dropping this context turns Skill recall into an untracked
/// global lookup and makes topology/quality attribution impossible.
#[derive(Clone, Debug)]
pub struct RecallRequest<'a> {
    pub query: &'a str,
    pub workspace_id: &'a str,
    pub session_id: &'a str,
    pub definition_id: &'a str,
}

#[derive(Clone, Debug, Default)]
pub struct WorkspaceFocus {
    pub open_files: Vec<String>,
    pub focus_symbols: Vec<String>,
    pub convention_text: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct WorkspaceContextSlice {
    pub text: String,
}

#[async_trait]
pub trait RecallPort: Send + Sync {
    async fn recall_finance(&self, query: &str) -> Result<Vec<RecallHit>, RuntimeError>;
    async fn recall_skill(&self, query: &str) -> Result<Vec<RecallHit>, RuntimeError>;
    async fn recall_general(&self, query: &str) -> Result<Vec<RecallHit>, RuntimeError>;

    /// Preferred path: one host round-trip. Default fans out to the three methods.
    async fn recall_bundle(&self, query: &str) -> Result<RecallBundle, RuntimeError> {
        Ok(RecallBundle {
            finance: self.recall_finance(query).await?,
            skill: self.recall_skill(query).await?,
            general: self.recall_general(query).await?,
        })
    }

    /// Context-aware path used by Rust Core. Implementations that do not need
    /// correlation retain the legacy behavior through this default.
    async fn recall_bundle_for(
        &self,
        request: RecallRequest<'_>,
    ) -> Result<RecallBundle, RuntimeError> {
        self.recall_bundle(request.query).await
    }
}

#[async_trait]
pub trait WorkspaceContextPort: Send + Sync {
    async fn snapshot(
        &self,
        workspace_id: &str,
        focus: &WorkspaceFocus,
    ) -> Result<WorkspaceContextSlice, RuntimeError>;
}

#[async_trait]
pub trait IdentityPromptLoader: Send + Sync {
    async fn load(&self, identity_prompt_ref: &str) -> Result<String, RuntimeError>;
}

#[derive(Debug, Default)]
pub struct EmptyRecallPort;

#[async_trait]
impl RecallPort for EmptyRecallPort {
    async fn recall_finance(&self, _query: &str) -> Result<Vec<RecallHit>, RuntimeError> {
        Ok(vec![])
    }
    async fn recall_skill(&self, _query: &str) -> Result<Vec<RecallHit>, RuntimeError> {
        Ok(vec![])
    }
    async fn recall_general(&self, _query: &str) -> Result<Vec<RecallHit>, RuntimeError> {
        Ok(vec![])
    }
}

#[derive(Debug, Default)]
pub struct EmptyWorkspacePort;

#[async_trait]
impl WorkspaceContextPort for EmptyWorkspacePort {
    async fn snapshot(
        &self,
        workspace_id: &str,
        focus: &WorkspaceFocus,
    ) -> Result<WorkspaceContextSlice, RuntimeError> {
        let mut parts = vec![format!("workspace: {workspace_id}")];
        if !focus.open_files.is_empty() {
            parts.push(format!("open: {}", focus.open_files.join(", ")));
        }
        if !focus.focus_symbols.is_empty() {
            parts.push(format!("symbols: {}", focus.focus_symbols.join(", ")));
        }
        if let Some(ref c) = focus.convention_text {
            parts.push(c.clone());
        }
        Ok(WorkspaceContextSlice {
            text: parts.join("\n"),
        })
    }
}

#[derive(Debug, Default)]
pub struct StaticIdentityLoader;

#[async_trait]
impl IdentityPromptLoader for StaticIdentityLoader {
    async fn load(&self, identity_prompt_ref: &str) -> Result<String, RuntimeError> {
        Ok(format!(
            "You are a Qubit quantitative research agent.\nidentity_ref={identity_prompt_ref}"
        ))
    }
}

/// Test helper: fixed identity string.
#[derive(Debug, Clone)]
pub struct MockIdentityLoader {
    pub text: String,
}

#[async_trait]
impl IdentityPromptLoader for MockIdentityLoader {
    async fn load(&self, _identity_prompt_ref: &str) -> Result<String, RuntimeError> {
        Ok(self.text.clone())
    }
}
