use thiserror::Error;

#[derive(Debug, Error)]
pub enum PolicyError {
    #[error("unknown recipe: {0}")]
    UnknownRecipe(String),
    #[error("invalid recipe json: {0}")]
    InvalidJson(#[from] serde_json::Error),
}
