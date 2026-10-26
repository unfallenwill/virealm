//! Process identity, status and lifecycle.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::diagnostics::DiagnosticEvent;
use crate::error::Result;
use crate::platform::ProcessHandle;
use crate::policy::{IsolationMode, NetworkAccess};

/// Durable process identity.
///
/// A PID alone is not an identity: Windows reuses PIDs. The pair of PID and
/// process creation time identifies one process instance for as long as the
/// original handle is held.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessId {
    pub pid: u32,
    /// Creation time as 100-nanosecond intervals since 1601-01-01 UTC.
    pub creation_time_100ns: u64,
}

impl std::fmt::Display for ProcessId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}:{}", self.pid, self.creation_time_100ns)
    }
}

/// Observed state of a managed process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProcessState {
    /// Created, not yet confirmed running.
    Starting,
    /// Running with the given process id.
    Running { pid: u32 },
    /// Exited with the given code.
    Exited { exit_code: u32 },
}

/// Isolation actually applied and verified after the process was created.
///
/// This is evidence, not intent: each `true` flag was checked against the
/// created process or its job, not copied from the request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedIsolation {
    pub mode: IsolationMode,
    pub job_object_attached: bool,
    pub app_container_token: bool,
    pub restricted_token: bool,
    pub low_integrity: bool,
    /// True only when path-level file access is enforced by AppContainer.
    pub file_access_restricted: bool,
    pub network_access: NetworkAccess,
    /// True when the child token's capability SIDs matched the network policy.
    pub network_capabilities_verified: bool,
    /// macOS: the child was created in its own POSIX process group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_group_attached: Option<bool>,
    /// macOS: the process group id of the managed tree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_group_id: Option<u32>,
    /// macOS: closing the runtime kills the group.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kill_on_close_armed: Option<bool>,
}

/// Status snapshot for a managed process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessStatus {
    pub id: ProcessId,
    pub state: ProcessState,
    pub applied: AppliedIsolation,
}

impl ProcessStatus {
    pub fn exit_code(&self) -> Option<u32> {
        match self.state {
            ProcessState::Exited { exit_code } => Some(exit_code),
            _ => None,
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self.state, ProcessState::Running { .. })
    }
}

/// A process owned by the runtime.
///
/// Dropping the value tears down the managed tree: on Windows the Job Object
/// handle closes (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), on macOS the process
/// group is killed. Call [`ManagedProcess::terminate`] for an explicit,
/// observable shutdown.
#[derive(Debug)]
pub struct ManagedProcess {
    id: ProcessId,
    handle: ProcessHandle,
    applied: AppliedIsolation,
    state: ProcessState,
    diagnostics: Vec<DiagnosticEvent>,
}

impl ManagedProcess {
    pub(crate) fn new(
        id: ProcessId,
        handle: ProcessHandle,
        applied: AppliedIsolation,
        initial_state: ProcessState,
        diagnostics: Vec<DiagnosticEvent>,
    ) -> Self {
        Self {
            id,
            handle,
            applied,
            state: initial_state,
            diagnostics,
        }
    }

    /// Durable identity of this process instance.
    pub fn id(&self) -> ProcessId {
        self.id
    }

    /// Isolation that was applied and verified at launch.
    pub fn applied_isolation(&self) -> &AppliedIsolation {
        &self.applied
    }

    /// Structured events emitted during launch and lifecycle operations.
    pub fn diagnostics(&self) -> &[DiagnosticEvent] {
        &self.diagnostics
    }

    /// Last known state. Use [`ManagedProcess::status`] to query the OS.
    pub fn state(&self) -> ProcessState {
        self.state
    }

    /// Query the operating system for the current status.
    pub fn status(&self) -> Result<ProcessStatus> {
        self.handle.status(self.id, &self.applied)
    }

    /// Wait up to `timeout` for exit.
    ///
    /// Returns `Running` when the timeout elapses. A zero timeout performs a
    /// non-blocking poll.
    pub fn wait(&mut self, timeout: Duration) -> Result<ProcessStatus> {
        let status = self.handle.wait(self.id, &self.applied, timeout)?;
        self.state = status.state;
        Ok(status)
    }

    /// Terminate the managed process tree and wait for the main process.
    ///
    /// Idempotent: calling it after exit still terminates any remaining
    /// children in the job and returns the main process status.
    pub fn terminate(&mut self) -> Result<ProcessStatus> {
        let status = self.handle.terminate(self.id, &self.applied)?;
        self.state = status.state;
        Ok(status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_id_display_contains_both_parts() {
        let id = ProcessId {
            pid: 42,
            creation_time_100ns: 7,
        };
        assert_eq!(id.to_string(), "42:7");
    }

    #[test]
    fn status_exposes_exit_code_only_when_exited() {
        let applied = AppliedIsolation {
            mode: IsolationMode::Managed,
            job_object_attached: true,
            app_container_token: false,
            restricted_token: false,
            low_integrity: false,
            file_access_restricted: false,
            network_access: NetworkAccess::Allow,
            network_capabilities_verified: false,
            process_group_attached: None,
            process_group_id: None,
            kill_on_close_armed: None,
        };
        let id = ProcessId {
            pid: 1,
            creation_time_100ns: 2,
        };

        let running = ProcessStatus {
            id,
            state: ProcessState::Running { pid: 1 },
            applied: applied.clone(),
        };
        assert_eq!(running.exit_code(), None);
        assert!(running.is_running());

        let exited = ProcessStatus {
            id,
            state: ProcessState::Exited { exit_code: 9 },
            applied,
        };
        assert_eq!(exited.exit_code(), Some(9));
        assert!(!exited.is_running());
    }
}
