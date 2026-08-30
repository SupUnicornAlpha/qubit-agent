//! Qubit Prime thin runtime harness (M6: cancel / supervisor / trigger).

pub mod admission;
pub mod bridge_host;
pub mod cancel;
pub mod cancel_registry;
pub mod chat_history;
pub mod checkpoint;
pub mod context;
pub mod core_db;
pub mod delivery;
pub mod engine;
pub mod error;
pub mod events;
pub mod hitl_inbox;
pub mod hitl_policy;
pub mod invocation;
pub mod model;
pub mod model_openai;
pub mod ports;
pub mod reasoning_extract;
pub mod session;
pub mod stall;
pub mod store;
pub mod supervisor;
pub mod tool_surface;
pub mod tools;
pub mod trigger;

pub use admission::{AgentAdmission, DefaultAdmission};
pub use bridge_host::{BridgeToolHost, CompositeToolHost};
pub use cancel::CancelToken;
pub use cancel_registry::TurnCancelRegistry;
pub use checkpoint::{CheckpointRecord, CheckpointStore, SqliteCheckpointStore};
pub use context::{
    BridgeRecallPort, BridgeWorkspacePort, ContextAssembler, DefaultContextAssembler,
    EmptyRecallPort, EmptyWorkspacePort, IdentityPromptLoader, MockIdentityLoader, RecallBundle,
    RecallHit, RecallPort, SlotAssembleInput, StaticIdentityLoader, WorkspaceContextPort,
    WorkspaceFocus,
};
pub use core_db::{default_core_db_path, CoreDb};
pub use delivery::{DeliveryEvaluator, LedgerDeliveryEvaluator};
pub use engine::{RunTurnOpts, TurnEngine, TurnOutcome};
pub use error::RuntimeError;
pub use hitl_inbox::{HitlInbox, MemoryHitlInbox, SqliteHitlInbox};
pub use hitl_policy::{
    evaluate_tool_batch_hitl, extract_ai_hitl_hint, is_high_risk_tool, HitlMode, HitlPolicy,
    ToolHitlDecision,
};
pub use invocation::{AgentInvoker, InvocationService};
pub use model::{
    CancellableSlowModel, FakeModelClient, ModelClient, NormalizedToolCall, SampleRequest,
    SampleResponse, ScriptedModelClient,
};
pub use model_openai::{OpenAiCompatibleClient, OpenAiCompatibleConfig};
pub use ports::{CoreRuntimeService, StartedTurn};
pub use reasoning_extract::{
    chunk_reasoning_for_stream, estimate_reasoning_tokens, extract_reasoning_from_chat_completion,
    extract_reasoning_from_message,
};
pub use session::SessionManager;
pub use stall::{stall_fingerprint, strip_tool_from_surface, tool_family};
pub use store::MemoryStore;
pub use supervisor::{RuntimeLimits, TurnSupervisor};
pub use tools::{
    extract_agent_invoke_callee_hint, extract_agent_invoke_goal, infer_callee_from_goal,
    parse_update_plan_args, parse_update_plan_args_for_session, resolve_callee_spec_id,
    FakeToolHost, L0ToolHost, ToolHost,
};
pub use trigger::{TriggerIngress, TriggerIngressService};
