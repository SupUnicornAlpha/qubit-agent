//! Runtime events streamed to clients (01 §6.3).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::delivery::DeliveryVerdict;
use crate::hitl::HitlPrompt;
use crate::ids::{ToolCallId, TurnId};
use crate::turn::Lifecycle;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEvent {
    TurnStarted {
        turn_id: TurnId,
        seq: u64,
        ts: i64,
    },
    Token {
        turn_id: TurnId,
        iteration: u32,
        text: String,
        seq: u64,
    },
    ToolStarted {
        turn_id: TurnId,
        call_id: ToolCallId,
        name: String,
        args: serde_json::Value,
        seq: u64,
    },
    ToolFinished {
        turn_id: TurnId,
        call_id: ToolCallId,
        ok: bool,
        observation_ref: String,
        seq: u64,
    },
    HitlRequested {
        prompt: HitlPrompt,
        inbox_id: String,
        seq: u64,
    },
    PlanUpdated {
        turn_id: TurnId,
        plan: serde_json::Value,
        seq: u64,
    },
    TurnCompleted {
        turn_id: TurnId,
        lifecycle: Lifecycle,
        delivery: DeliveryVerdict,
        seq: u64,
    },
    TurnFailed {
        turn_id: TurnId,
        error: ErrorObject,
        seq: u64,
    },
    RuntimeDegraded {
        reason: String,
        seq: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorObject {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}
