//! Qubit Prime thin runtime harness (M6: cancel / supervisor / trigger).

pub mod admission;
pub mod bridge_host;
pub mod cancel;
pub mod cancel_registry;
pub mod checkpoint;
pub mod context;
pub mod core_db;
pub mod delivery;
pub mod engine;
pub mod error;
pub mod events;
pub mod hitl_inbox;
pub mod invocation;
pub mod model;
pub mod model_openai;
pub mod ports;
pub mod session;
pub mod store;
pub mod supervisor;
pub mod tools;
pub mod trigger;

pub use admission::{AgentAdmission, DefaultAdmission};
pub use bridge_host::{BridgeToolHost, CompositeToolHost};
pub use cancel::CancelToken;
pub use cancel_registry::TurnCancelRegistry;
pub use checkpoint::{CheckpointRecord, CheckpointStore, SqliteCheckpointStore};
pub use context::{
    BridgeRecallPort, BridgeWorkspacePort, ContextAssembler, DefaultContextAssembler,
    EmptyRecallPort, EmptyWorkspacePort, IdentityPromptLoader, MockIdentityLoader, RecallPort,
    SlotAssembleInput, StaticIdentityLoader, WorkspaceContextPort, WorkspaceFocus,
};
pub use core_db::{default_core_db_path, CoreDb};
pub use delivery::{DeliveryEvaluator, LedgerDeliveryEvaluator};
pub use engine::{RunTurnOpts, TurnEngine, TurnOutcome};
pub use error::RuntimeError;
pub use hitl_inbox::{HitlInbox, MemoryHitlInbox, SqliteHitlInbox};
pub use invocation::{AgentInvoker, InvocationService};
pub use model::{
    CancellableSlowModel, FakeModelClient, ModelClient, NormalizedToolCall, SampleRequest,
    SampleResponse, ScriptedModelClient,
};
pub use model_openai::{OpenAiCompatibleClient, OpenAiCompatibleConfig};
pub use ports::{CoreRuntimeService, StartedTurn};
pub use session::SessionManager;
pub use store::MemoryStore;
pub use supervisor::{RuntimeLimits, TurnSupervisor};
pub use tools::{
    extract_agent_invoke_callee_hint, extract_agent_invoke_goal, infer_callee_from_goal,
    parse_update_plan_args, parse_update_plan_args_for_session, resolve_callee_spec_id,
    FakeToolHost, L0ToolHost, ToolHost,
};
pub use trigger::{TriggerIngress, TriggerIngressService};
