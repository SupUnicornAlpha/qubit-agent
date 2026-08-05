//! ID helpers and opaque string newtypes used across the protocol.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

macro_rules! id_newtype {
    ($name:ident, $prefix:expr, $doc:expr) => {
        #[doc = $doc]
        #[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn new(raw: impl Into<String>) -> Self {
                Self(raw.into())
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn prefix() -> &'static str {
                $prefix
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }
    };
}

id_newtype!(SessionId, "ses_", "Session id (`ses_*`).");
id_newtype!(TurnId, "trn_", "Turn id (`trn_*`).");
id_newtype!(AgentSpecId, "def_", "AgentSpec id (`def_*` / `agt_*`).");
id_newtype!(AgentInstanceId, "inst_", "Agent instance id (`inst_*`).");
id_newtype!(InvocationId, "inv_", "Invocation id (`inv_*`).");
id_newtype!(ToolCallId, "tc_", "Tool call id (`tc_*`).");
id_newtype!(HitlPromptId, "hitl_", "HITL prompt id (`hitl_*`).");
id_newtype!(HitlInboxId, "inbox_", "HITL inbox item id (`inbox_*`).");
id_newtype!(WorkspaceId, "ws_", "Workspace id.");
id_newtype!(TriggerEventId, "evt_", "Trigger event id (idempotency key).");
