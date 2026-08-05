//! Qubit Prime shared protocol types.
//!
//! Pure data + serde/schemars. No business IO. See docs/qubit-prime/01 §6 / §15.

pub mod agent;
pub mod context;
pub mod delivery;
pub mod error;
pub mod events;
pub mod hitl;
pub mod ids;
pub mod invocation;
pub mod mode;
pub mod policy;
pub mod rpc;
pub mod session;
pub mod turn;

pub use agent::*;
pub use context::*;
pub use delivery::*;
pub use error::*;
pub use events::*;
pub use hitl::*;
pub use ids::*;
pub use invocation::*;
pub use mode::*;
pub use policy::*;
pub use rpc::*;
pub use session::*;
pub use turn::*;

/// Protocol wire version for Envelope / RPC negotiation.
pub const PROTOCOL_VERSION: &str = "0.1.0";
