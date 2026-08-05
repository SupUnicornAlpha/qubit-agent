//! AgentAdmission — only place that branches on ExecutionKind (01 §6.6.4).

use qubit_protocol::{
    AgentInstance, AgentSpec, CallerSelector, ExecutionKind, ProtocolError, TriggerEvent,
};

use crate::error::RuntimeError;

pub trait AgentAdmission: Send + Sync {
    fn admit_user_turn(&self, spec: &AgentSpec) -> Result<(), RuntimeError>;
    fn admit_invocation(
        &self,
        caller_spec: &AgentSpec,
        callee_spec: &AgentSpec,
    ) -> Result<(), RuntimeError>;
    fn admit_trigger(&self, spec: &AgentSpec, _event: &TriggerEvent) -> Result<(), RuntimeError>;
}

#[derive(Debug, Default, Clone)]
pub struct DefaultAdmission;

impl AgentAdmission for DefaultAdmission {
    fn admit_user_turn(&self, spec: &AgentSpec) -> Result<(), RuntimeError> {
        if !spec.enabled {
            return Err(ProtocolError::AdmissionDenied {
                message: "agent disabled".into(),
            }
            .into());
        }
        match spec.execution_kind {
            ExecutionKind::Primary => Ok(()),
            ExecutionKind::Subagent | ExecutionKind::Reactor => Err(ProtocolError::AdmissionDenied {
                message: format!(
                    "{:?} cannot accept user turns",
                    spec.execution_kind
                ),
            }
            .into()),
        }
    }

    fn admit_invocation(
        &self,
        caller_spec: &AgentSpec,
        callee_spec: &AgentSpec,
    ) -> Result<(), RuntimeError> {
        if !callee_spec.enabled {
            return Err(ProtocolError::AdmissionDenied {
                message: "callee disabled".into(),
            }
            .into());
        }
        match callee_spec.execution_kind {
            ExecutionKind::Reactor => {
                return Err(ProtocolError::AdmissionDenied {
                    message: "reactor is trigger-only; use trigger.ingest".into(),
                }
                .into());
            }
            ExecutionKind::Primary | ExecutionKind::Subagent => {}
        }

        if callee_spec.allowed_callers.is_empty() {
            // Defaults: subagent ← primary only; primary ← primary
            return match (caller_spec.execution_kind, callee_spec.execution_kind) {
                (ExecutionKind::Primary, ExecutionKind::Subagent) => Ok(()),
                (ExecutionKind::Primary, ExecutionKind::Primary) => Ok(()),
                _ => Err(ProtocolError::AdmissionDenied {
                    message: "caller not allowed by default rules".into(),
                }
                .into()),
            };
        }

        let ok = callee_spec.allowed_callers.iter().any(|sel| match sel {
            CallerSelector::SpecId { id } => id == caller_spec.id.as_str(),
            CallerSelector::Label { label } => caller_spec.labels.iter().any(|l| l == label),
            CallerSelector::ExecutionKind { execution_kind } => {
                *execution_kind == caller_spec.execution_kind
            }
        });
        if ok {
            Ok(())
        } else {
            Err(ProtocolError::AdmissionDenied {
                message: "caller not in allowed_callers".into(),
            }
            .into())
        }
    }

    fn admit_trigger(&self, spec: &AgentSpec, _event: &TriggerEvent) -> Result<(), RuntimeError> {
        if !spec.enabled {
            return Err(ProtocolError::AdmissionDenied {
                message: "agent disabled".into(),
            }
            .into());
        }
        match spec.execution_kind {
            ExecutionKind::Reactor => Ok(()),
            other => Err(ProtocolError::AdmissionDenied {
                message: format!("{other:?} cannot accept triggers"),
            }
            .into()),
        }
    }
}

/// Convenience for tests that still pass instances.
pub fn admit_user_turn_for_instance(
    admission: &impl AgentAdmission,
    _instance: &AgentInstance,
    spec: &AgentSpec,
) -> Result<(), RuntimeError> {
    admission.admit_user_turn(spec)
}
