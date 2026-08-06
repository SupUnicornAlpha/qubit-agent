//! Context Protocol assembly (01 §15).

mod assemble;
mod bridge_recall;
mod bridge_workspace;
mod ports;

pub use assemble::{ContextAssembler, DefaultContextAssembler, SlotAssembleInput};
pub use bridge_recall::BridgeRecallPort;
pub use bridge_workspace::BridgeWorkspacePort;
pub use ports::{
    EmptyRecallPort, EmptyWorkspacePort, IdentityPromptLoader, MockIdentityLoader, RecallBundle,
    RecallHit, RecallPort, StaticIdentityLoader, WorkspaceContextPort, WorkspaceContextSlice,
    WorkspaceFocus,
};
